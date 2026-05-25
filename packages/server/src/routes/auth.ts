import { Hono } from 'hono'
import { setCookie, deleteCookie } from 'hono/cookie'
import { getDb } from '../db/index.js'
import bcrypt from 'bcryptjs'
import { nanoid } from 'nanoid'
import { encryptJWE } from '../lib/session'
import { requireAuth, type AppEnv, type AppSession } from '../middleware/auth'
import { provisionUserResources, rollbackProvisionedResources } from '../cloudbase/provision.js'
import { acquireEnv } from '../cloudbase/env-lifecycle.js'

const SESSION_COOKIE_NAME = 'nex_session'
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365 // 1 year in seconds

const auth = new Hono<AppEnv>()

auth.post('/register', async (c) => {
  try {
    const body = await c.req.json()
    const { username, password } = body

    if (!username || !password || typeof username !== 'string' || typeof password !== 'string') {
      return c.json({ error: 'Username and password are required' }, 400)
    }

    const trimmedUsername = username.trim().toLowerCase()
    if (trimmedUsername.length < 3) {
      return c.json({ error: 'Username must be at least 3 characters' }, 400)
    }
    if (password.length < 6) {
      return c.json({ error: 'Password must be at least 6 characters' }, 400)
    }

    // Check if username already exists
    const existing = await getDb().users.findByProviderAndExternalId('local', trimmedUsername)

    if (existing) {
      return c.json({ error: 'Username already taken' }, 409)
    }

    // Create user — first registered user becomes admin automatically
    const userId = nanoid()
    const now = Date.now()
    const passwordHash = await bcrypt.hash(password, 12)
    const userCount = await getDb().users.count()
    const role = userCount === 0 ? 'admin' : 'user'

    await getDb().users.create({
      id: userId,
      provider: 'local',
      externalId: trimmedUsername,
      accessToken: '',
      username: trimmedUsername,
      role,
      status: 'active',
      apiKey: `sak_${nanoid(40)}`,
    })

    await getDb().localCredentials.create({
      userId,
      passwordHash,
      createdAt: now,
      updatedAt: now,
    })

    // Create session
    const session: AppSession = {
      created: now,
      authProvider: 'local',
      user: {
        id: userId,
        username: trimmedUsername,
        email: undefined,
        name: trimmedUsername,
        avatar: `https://ui-avatars.com/api/?name=${encodeURIComponent(trimmedUsername)}&background=6366f1&color=fff`,
      },
    }

    const sessionValue = await encryptJWE(session, '1y')

    // CloudBase 环境配置 — 通过统一生命周期接口
    const { getProvisionMode } = await import('../lib/provision-config.js')
    const provisionMode = await getProvisionMode()

    if (process.env.TCB_SECRET_ID && process.env.TCB_SECRET_KEY && provisionMode === 'isolated') {
      const resourceId = nanoid()

      // 同步创建独立环境，失败则回滚账号
      try {
        await getDb().userResources.create({
          id: resourceId,
          userId,
          status: 'processing',
          envId: null,
          envAlias: null,
          envRegion: null,
          cosTagValue: null,
          policyHash: null,
          camUsername: null,
          camSecretId: null,
          camSecretKey: null,
          policyId: null,
          failStep: null,
          failReason: null,
          createdAt: now,
          updatedAt: now,
        })

        const result = await acquireEnv({ userId, username: trimmedUsername, mode: 'isolated' })
        await getDb().userResources.update(resourceId, {
          status: 'success',
          envId: result.envId,
          envAlias: result.envAlias,
          envRegion: result.envRegion,
          cosTagValue: result.cosTagValue,
          policyHash: result.policyHash,
          camUsername: result.camUsername,
          camSecretId: result.camSecretId,
          camSecretKey: result.camSecretKey || null,
          policyId: result.policyId,
          updatedAt: Date.now(),
        })
        console.log(`[provision] User env ready`)
      } catch (err) {
        // 环境创建失败，回滚云端资源和本地账号
        console.error('[provision] Failed, rolling back:', (err as Error).message)
        try {
          const partialResult: Partial<import('../cloudbase/provision.js').ProvisionResult> = {}
          partialResult.camUsername = `vibe_${userId.substring(0, 20)}`
          await rollbackProvisionedResources(partialResult)
        } catch {
          // rollback best-effort
        }
        try {
          await getDb().users.deleteById(userId)
        } catch {
          // rollback best-effort
        }
        return c.json({ error: 'Failed to create cloud environment, please try again later' }, 500)
      }
    }
    // shared / task：注册不做 provision

    setCookie(c, SESSION_COOKIE_NAME, sessionValue, {
      path: '/',
      maxAge: COOKIE_MAX_AGE,
      httpOnly: true,
      sameSite: 'Lax',
    })

    // Fetch envId (shared mode creates it synchronously above)
    let envId: string | undefined
    try {
      const resource = await getDb().userResources.findByUserId(userId)
      envId = resource?.envId || undefined
    } catch {
      // ignore
    }

    return c.json({
      success: true,
      user: {
        id: userId,
        username: trimmedUsername,
        email: undefined,
        name: trimmedUsername,
        avatar: `https://ui-avatars.com/api/?name=${encodeURIComponent(trimmedUsername)}&background=6366f1&color=fff`,
        role: 'user',
      },
      envId,
    })
  } catch (error) {
    console.error('Error registering local user:', error)
    const msg = (error as Error).message || ''
    if (msg.includes('Invalid Content Encryption Key') || msg.includes('JWE')) {
      return c.json(
        {
          error:
            'Session encryption misconfigured: JWE_SECRET must be 32 random bytes encoded as base64 (see init.sh / .env.example), not hex.',
        },
        500,
      )
    }
    if (msg.includes('Missing JWE secret')) {
      return c.json({ error: 'Server missing JWE_SECRET in packages/server/.env' }, 500)
    }
    return c.json(
      {
        error: 'Registration failed',
        ...(process.env.NODE_ENV !== 'production' && msg ? { detail: msg } : {}),
      },
      500,
    )
  }
})

auth.post('/login', async (c) => {
  try {
    const body = await c.req.json()
    const { username, password } = body

    if (!username || !password || typeof username !== 'string' || typeof password !== 'string') {
      return c.json({ error: 'Username and password are required' }, 400)
    }

    const trimmedUsername = username.trim().toLowerCase()

    // Find user
    const user = await getDb().users.findByProviderAndExternalId('local', trimmedUsername)

    if (!user) {
      return c.json({ error: 'Invalid username or password' }, 401)
    }

    // Get credentials
    const cred = await getDb().localCredentials.findByUserId(user.id)

    if (!cred) {
      return c.json({ error: 'Invalid username or password' }, 401)
    }

    // Verify password
    const valid = await bcrypt.compare(password, cred.passwordHash)
    if (!valid) {
      return c.json({ error: 'Invalid username or password' }, 401)
    }

    // Check if user is disabled
    if (user.status === 'disabled') {
      return c.json({ error: 'Account has been disabled' }, 403)
    }

    // Update last login
    await getDb().users.update(user.id, { lastLoginAt: Date.now(), updatedAt: Date.now() })

    // Create session
    const session: AppSession = {
      created: Date.now(),
      authProvider: 'local',
      user: {
        id: user.id,
        username: user.username,
        email: user.email || undefined,
        name: user.name || user.username,
        avatar:
          user.avatarUrl ||
          `https://ui-avatars.com/api/?name=${encodeURIComponent(user.username)}&background=6366f1&color=fff`,
      },
    }

    const sessionValue = await encryptJWE(session, '1y')

    setCookie(c, SESSION_COOKIE_NAME, sessionValue, {
      path: '/',
      maxAge: COOKIE_MAX_AGE,
      httpOnly: true,
      sameSite: 'Lax',
    })

    // Fetch envId for the response (same logic as /me)
    let envId: string | undefined
    try {
      const resource = await getDb().userResources.findByUserId(user.id)
      envId = resource?.envId || undefined
    } catch {
      // ignore
    }

    return c.json({
      success: true,
      user: {
        id: user.id,
        username: user.username,
        email: user.email || undefined,
        name: user.name || user.username,
        avatar:
          user.avatarUrl ||
          `https://ui-avatars.com/api/?name=${encodeURIComponent(user.username)}&background=6366f1&color=fff`,
        role: user.role || 'user',
      },
      envId,
    })
  } catch (error) {
    console.error('Error logging in local user:', error)
    return c.json({ error: 'Login failed' }, 500)
  }
})

auth.post('/signout', async (c) => {
  deleteCookie(c, SESSION_COOKIE_NAME, { path: '/' })
  return c.json({ success: true })
})

auth.get('/me', async (c) => {
  const session = c.get('session')

  if (!session) {
    return c.json({ user: undefined })
  }

  // Get user role and check status
  const user = await getDb().users.findById(session.user.id)

  // If user is disabled, clear session and return no user
  if (user?.status === 'disabled') {
    deleteCookie(c, SESSION_COOKIE_NAME, { path: '/' })
    return c.json({ user: undefined })
  }

  // Get user's envId and provision status
  let envId: string | undefined
  let provisionStatus: string = 'not_started'
  try {
    const resource = await getDb().userResources.findByUserId(session.user.id)
    envId = resource?.envId || undefined
    provisionStatus = resource?.status || 'not_started'
  } catch {
    // ignore
  }

  return c.json({
    user: {
      ...session.user,
      role: user?.role || 'user',
    },
    authProvider: session.authProvider,
    envId,
    provisionStatus,
  })
})

// 查询当前用户的 CloudBase 环境状态
auth.get('/provision-status', async (c) => {
  const session = c.get('session')
  if (!session?.user?.id) return c.json({ error: 'Unauthorized' }, 401)

  const { getProvisionMode } = await import('../lib/provision-config.js')
  const provisionMode = await getProvisionMode()

  // shared / task 模式注册时不写 user_resources：
  //   - shared 永远 ready（直接用支撑账号）
  //   - task 注册时 ready，待用户创建 task 时各自 provision
  if (provisionMode === 'shared' || provisionMode === 'task') {
    return c.json({
      status: 'success',
      envId: provisionMode === 'shared' ? process.env.TCB_ENV_ID || null : null,
      camUsername: null,
      camSecretId: null,
      failReason: null,
      createdAt: null,
      updatedAt: null,
    })
  }

  const resource = await getDb().userResources.findByUserId(session.user.id)

  if (!resource) return c.json({ status: 'not_started' })

  return c.json({
    status: resource.status,
    envId: resource.envId,
    camUsername: resource.camUsername,
    camSecretId: resource.camSecretId,
    failReason: resource.failReason,
    createdAt: resource.createdAt,
    updatedAt: resource.updatedAt,
  })
})

// Retry failed provision
auth.post('/provision-retry', async (c) => {
  const session = c.get('session')
  if (!session?.user?.id) return c.json({ error: 'Unauthorized' }, 401)

  const resource = await getDb().userResources.findByUserId(session.user.id)
  if (!resource) return c.json({ error: 'No resource record found' }, 404)
  if (resource.status !== 'failed') return c.json({ error: 'Can only retry failed provisions' }, 400)

  // Reset to processing and retry
  await getDb().userResources.update(resource.id, {
    status: 'processing',
    failReason: null,
    failStep: null,
    updatedAt: Date.now(),
  })

  const user = await getDb().users.findById(session.user.id)
  const username = user?.username || session.user.username || 'unknown'

  provisionUserResources(session.user.id, username)
    .then(async (result) => {
      await getDb().userResources.update(resource.id, {
        status: 'success',
        envId: result.envId,
        envAlias: result.envAlias,
        envRegion: result.envRegion,
        cosTagValue: result.cosTagValue,
        policyHash: result.policyHash,
        camUsername: result.camUsername,
        camSecretId: result.camSecretId,
        camSecretKey: result.camSecretKey || null,
        policyId: result.policyId,
        updatedAt: Date.now(),
      })
      console.log('[provision-retry] User env ready')
    })
    .catch(async (err) => {
      await getDb().userResources.update(resource.id, {
        status: 'failed',
        failStep: err.__provisionFailStep || null,
        failReason: err.message,
        updatedAt: Date.now(),
      })
      console.error('[provision-retry] Failed:', err.message)
    })

  return c.json({ status: 'processing' })
})

// Rate limit info
auth.get('/rate-limit', async (c) => {
  const session = c.get('session')
  if (!session?.user?.id) return c.json({ error: 'Unauthorized' }, 401)

  // Return generous default limits
  return c.json({
    allowed: true,
    remaining: 100,
    used: 0,
    total: 100,
    resetAt: new Date(Date.now() + 86400000).toISOString(),
  })
})

// GET /auth-config - Expose auth configuration to frontend (no session required)
auth.get('/auth-config', (c) => {
  const providers = 'local,github'.split(',').map((s) => s.trim())
  const githubMode = process.env.AUTH_GITHUB_MODE || 'direct' // 'direct' | 'cloudbase'
  const tcbEnvId = process.env.TCB_ENV_ID || ''
  return c.json({ providers, githubMode, tcbEnvId })
})

// ─── API Key (view / reset) ────────────────────────────────────────────────

// Get current user's API key (plaintext).
auth.get('/api-key', async (c) => {
  const authErr = requireAuth(c)
  if (authErr) return authErr
  const session = c.get('session')!
  const user = await getDb().users.findById(session.user.id)
  if (!user) return c.json({ error: 'User not found' }, 404)
  return c.json({ apiKey: user.apiKey || null })
})

// Reset (regenerate) current user's API key.
auth.post('/api-key/reset', async (c) => {
  const authErr = requireAuth(c)
  if (authErr) return authErr
  const session = c.get('session')!

  const plainKey = `sak_${nanoid(40)}`
  await getDb().users.update(session.user.id, { apiKey: plainKey })
  return c.json({ apiKey: plainKey })
})

export default auth
