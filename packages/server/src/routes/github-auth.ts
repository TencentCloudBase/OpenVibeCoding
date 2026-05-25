import { Hono } from 'hono'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import { getDb } from '../db/index.js'
import { nanoid } from 'nanoid'
import { encryptJWE } from '../lib/session'
import { encrypt } from '../lib/crypto'
import type { AppEnv, AppSession } from '../middleware/auth'
import { provisionUserResources } from '../cloudbase/provision.js'

const SESSION_COOKIE_NAME = 'nex_session'
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365 // 1 year in seconds

function generateState(): string {
  return nanoid(32)
}

const githubAuth = new Hono<AppEnv>()

// GET /api/auth/github/login - Redirect to GitHub OAuth for sign-in (no session required)
githubAuth.get('/login', async (c) => {
  const clientId = process.env.GITHUB_CLIENT_ID
  const origin = new URL(c.req.url).origin
  const redirectUri = `${origin}/api/auth/github/callback`

  // Determine the frontend origin for redirect after OAuth completes
  // In dev mode, frontend may be on a different port (e.g. Vite dev server)
  const referer = c.req.header('referer')
  const frontendOrigin = referer ? new URL(referer).origin : origin

  if (!clientId) {
    return c.redirect(`${frontendOrigin}/login?error=github_not_configured`)
  }

  const state = generateState()
  const next = c.req.query('next') ?? '/'
  const redirectPath = next.startsWith('/') ? next : '/'
  const redirectTo = `${frontendOrigin}${redirectPath}`

  setCookie(c, 'github_auth_mode', 'signin', {
    path: '/',
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge: 60 * 10,
    sameSite: 'Lax',
  })
  setCookie(c, 'github_auth_state', state, {
    path: '/',
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge: 60 * 10,
    sameSite: 'Lax',
  })
  setCookie(c, 'github_auth_redirect_to', redirectTo, {
    path: '/',
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge: 60 * 10,
    sameSite: 'Lax',
  })

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: 'repo,read:user,user:email',
    state: state,
  })

  return c.redirect(`https://github.com/login/oauth/authorize?${params.toString()}`)
})

// GET /api/auth/github/signin - Redirect to GitHub OAuth (connect flow for existing users)
githubAuth.get('/signin', async (c) => {
  const session = c.get('session')
  if (!session?.user) {
    return c.redirect('/')
  }

  const clientId = process.env.GITHUB_CLIENT_ID
  const origin = new URL(c.req.url).origin
  const redirectUri = `${origin}/api/auth/github/callback`

  const referer = c.req.header('referer')
  const frontendOrigin = referer ? new URL(referer).origin : origin

  if (!clientId) {
    return c.redirect(`${frontendOrigin}/?error=github_not_configured`)
  }

  const state = generateState()
  const next = c.req.query('next') ?? '/'
  const redirectPath = next.startsWith('/') ? next : '/'
  const redirectTo = `${frontendOrigin}${redirectPath}`

  setCookie(c, 'github_oauth_redirect_to', redirectTo, {
    path: '/',
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge: 60 * 10,
    sameSite: 'Lax',
  })
  setCookie(c, 'github_oauth_state', state, {
    path: '/',
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge: 60 * 10,
    sameSite: 'Lax',
  })
  setCookie(c, 'github_oauth_user_id', session.user.id, {
    path: '/',
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge: 60 * 10,
    sameSite: 'Lax',
  })

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: 'repo,read:user,user:email',
    state: state,
  })

  return c.redirect(`https://github.com/login/oauth/authorize?${params.toString()}`)
})

// GET /api/auth/github/callback - Handle OAuth callback
githubAuth.get('/callback', async (c) => {
  const code = c.req.query('code')
  const state = c.req.query('state')

  const authMode = getCookie(c, 'github_auth_mode') ?? null
  const isSignInFlow = authMode === 'signin'

  const storedState = getCookie(c, authMode ? 'github_auth_state' : 'github_oauth_state') ?? null
  const storedRedirectTo = getCookie(c, authMode ? 'github_auth_redirect_to' : 'github_oauth_redirect_to') ?? null
  const storedUserId = getCookie(c, 'github_oauth_user_id') ?? null

  if (isSignInFlow) {
    if (!code || !state || storedState !== state || !storedRedirectTo) {
      return c.text('Invalid OAuth state', 400)
    }
  } else {
    if (!code || !state || storedState !== state || !storedRedirectTo || !storedUserId) {
      return c.text('Invalid OAuth state', 400)
    }
  }

  const clientId = process.env.GITHUB_CLIENT_ID
  const clientSecret = process.env.GITHUB_CLIENT_SECRET

  if (!clientId || !clientSecret) {
    return c.text('GitHub OAuth not configured', 500)
  }

  try {
    // Exchange code for access token
    const tokenResponse = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        code: code,
      }),
    })

    if (!tokenResponse.ok) {
      console.error('[GitHub Callback] Token exchange failed')
      return c.text('Failed to exchange code for token', 400)
    }

    const tokenData = (await tokenResponse.json()) as {
      access_token: string
      scope: string
      token_type: string
      error?: string
      error_description?: string
    }

    if (!tokenData.access_token) {
      console.error('[GitHub Callback] Failed to get GitHub access token')
      return c.text(
        `Failed to authenticate with GitHub: ${tokenData.error_description || tokenData.error || 'Unknown error'}`,
        400,
      )
    }

    // Fetch GitHub user info
    const userResponse = await fetch('https://api.github.com/user', {
      headers: {
        Authorization: `Bearer ${tokenData.access_token}`,
        Accept: 'application/vnd.github.v3+json',
      },
    })

    const githubUser = (await userResponse.json()) as {
      login: string
      id: number
      email: string | null
      name: string | null
      avatar_url: string
    }

    if (isSignInFlow) {
      // SIGN-IN FLOW: Create or update user, create session

      // Fetch email if not public
      let email = githubUser.email
      if (!email) {
        try {
          const emailsResponse = await fetch('https://api.github.com/user/emails', {
            headers: {
              Authorization: `Bearer ${tokenData.access_token}`,
              Accept: 'application/vnd.github.v3+json',
            },
          })
          if (emailsResponse.ok) {
            const emails = (await emailsResponse.json()) as Array<{
              email: string
              primary: boolean
              verified: boolean
            }>
            const primaryEmail = emails.find((e) => e.primary && e.verified)
            email = primaryEmail?.email || emails[0]?.email || null
          }
        } catch {
          // ignore
        }
      }

      // Upsert user in DB
      const now = Date.now()
      const externalId = `${githubUser.id}`
      const encryptedToken = encrypt(tokenData.access_token)

      const existing = await getDb().users.findByProviderAndExternalId('github', externalId)

      let userId: string
      if (existing) {
        // Check if user is disabled
        if (existing.status === 'disabled') {
          const loginUrl = new URL('/login', c.req.url)
          loginUrl.searchParams.set('error', 'disabled')
          return c.redirect(loginUrl.toString())
        }
        userId = existing.id
        await getDb().users.update(userId, {
          accessToken: encryptedToken,
          scope: tokenData.scope,
          username: githubUser.login,
          email: email || null,
          name: githubUser.name || githubUser.login,
          avatarUrl: githubUser.avatar_url,
          updatedAt: now,
          lastLoginAt: now,
        })
      } else {
        userId = nanoid()
        const userCount = await getDb().users.count()
        await getDb().users.create({
          id: userId,
          provider: 'github',
          externalId: externalId,
          accessToken: encryptedToken,
          scope: tokenData.scope,
          username: githubUser.login,
          email: email || undefined,
          name: githubUser.name || githubUser.login,
          avatarUrl: githubUser.avatar_url,
          role: userCount === 0 ? 'admin' : 'user',
          status: 'active',
          apiKey: encrypt(`sak_${nanoid(40)}`),
        })
      }

      // Provision CloudBase resources for new users
      // 仅 isolated 模式需要预建 user-level env；shared / task 不写 user_resources
      if (process.env.TCB_SECRET_ID && process.env.TCB_SECRET_KEY) {
        const existingResource = await getDb().userResources.findByUserId(userId)
        if (!existingResource) {
          const { getProvisionMode } = await import('../lib/provision-config.js')
          const provisionMode = await getProvisionMode()

          if (provisionMode === 'isolated') {
            const resourceId = nanoid()
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
            provisionUserResources(userId, githubUser.login)
              .then(async (result) => {
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
              })
              .catch(async (err) => {
                await getDb().userResources.update(resourceId, {
                  status: 'failed',
                  failStep: err.__provisionFailStep || null,
                  failReason: err.message,
                  updatedAt: Date.now(),
                })
              })
          }
          // shared / task：不写 user_resources，运行时按 mode 解析
        }
      }

      const session: AppSession = {
        created: now,
        authProvider: 'github',
        user: {
          id: userId,
          username: githubUser.login,
          email: email || undefined,
          name: githubUser.name || githubUser.login,
          avatar: githubUser.avatar_url,
        },
      }

      const sessionValue = await encryptJWE(session, '1y')

      // Clean up cookies
      deleteCookie(c, 'github_auth_state', { path: '/' })
      deleteCookie(c, 'github_auth_redirect_to', { path: '/' })
      deleteCookie(c, 'github_auth_mode', { path: '/' })

      // Set session cookie
      setCookie(c, SESSION_COOKIE_NAME, sessionValue, {
        path: '/',
        maxAge: COOKIE_MAX_AGE,
        httpOnly: true,
        sameSite: 'Lax',
        secure: process.env.NODE_ENV === 'production',
      })

      return c.redirect(storedRedirectTo!)
    } else {
      // CONNECT FLOW: Add GitHub account to existing user
      const encryptedToken = encrypt(tokenData.access_token)

      const existingAccount = await getDb().accounts.findByUserIdAndProvider(storedUserId!, 'github')
      const accountByExternal = await getDb().accounts.findByProviderAndExternalUserId('github', `${githubUser.id}`)

      if (accountByExternal) {
        const connectedUserId = accountByExternal.userId

        if (connectedUserId !== storedUserId) {
          // Merge accounts: transfer everything from old user to new user
          // TODO: user_resources 暂不迁移；如果旧账号在 isolated/task 模式下创建了云资源，
          // 删旧 user 时这些资源不会被清理（DB row 因 onDelete:cascade 会级联删，但腾讯云资源遗留）。
          // 当前合并场景罕见，先留 TODO，需要时再加 transferUserResources / destroyUserResources 逻辑。
          await getDb().tasks.updateUserId(connectedUserId, storedUserId!)
          await getDb().connectors.updateUserId(connectedUserId, storedUserId!)
          await getDb().accounts.updateUserId(connectedUserId, storedUserId!)
          await getDb().keys.updateUserId(connectedUserId, storedUserId!)
          await getDb().users.deleteById(connectedUserId)

          await getDb().accounts.update(accountByExternal.id, {
            userId: storedUserId!,
            accessToken: encryptedToken,
            scope: tokenData.scope,
            username: githubUser.login,
            updatedAt: Date.now(),
          })
        } else {
          // Same user, just update the token
          await getDb().accounts.update(accountByExternal.id, {
            accessToken: encryptedToken,
            scope: tokenData.scope,
            username: githubUser.login,
            updatedAt: Date.now(),
          })
        }
      } else {
        await getDb().accounts.create({
          id: nanoid(),
          userId: storedUserId!,
          provider: 'github',
          externalUserId: `${githubUser.id}`,
          accessToken: encryptedToken,
          refreshToken: null,
          expiresAt: null,
          scope: tokenData.scope,
          username: githubUser.login,
        })
      }

      // Clean up cookies
      if (authMode) {
        deleteCookie(c, 'github_auth_state', { path: '/' })
        deleteCookie(c, 'github_auth_redirect_to', { path: '/' })
        deleteCookie(c, 'github_auth_mode', { path: '/' })
      } else {
        deleteCookie(c, 'github_oauth_state', { path: '/' })
        deleteCookie(c, 'github_oauth_redirect_to', { path: '/' })
      }
      deleteCookie(c, 'github_oauth_user_id', { path: '/' })

      return c.redirect(storedRedirectTo!)
    }
  } catch (error) {
    console.error('[GitHub Callback] OAuth callback error:', error)
    return c.text('Failed to complete GitHub authentication', 500)
  }
})

// GET /api/auth/github/status - Check GitHub connection status
githubAuth.get('/status', async (c) => {
  const session = c.get('session')

  if (!session?.user) {
    return c.json({ connected: false })
  }

  if (!session.user.id) {
    console.error('GitHub status check: session.user.id is undefined')
    return c.json({ connected: false })
  }

  try {
    // Check if user has GitHub as connected account
    const account = await getDb().accounts.findByUserIdAndProvider(session.user.id, 'github')

    if (account) {
      return c.json({
        connected: true,
        username: account.username,
        connectedAt: account.createdAt,
      })
    }

    // Check if user signed in with GitHub (primary account)
    const user = await getDb().users.findById(session.user.id)

    if (user && user.provider === 'github') {
      return c.json({
        connected: true,
        username: user.username,
        connectedAt: user.createdAt,
      })
    }

    return c.json({ connected: false })
  } catch (error) {
    console.error('Error checking GitHub connection status:', error)
    return c.json({ connected: false, error: 'Failed to check status' }, 500)
  }
})

// POST /api/auth/github/disconnect - Disconnect GitHub account
githubAuth.post('/disconnect', async (c) => {
  const session = c.get('session')

  if (!session?.user) {
    return c.json({ error: 'Not authenticated' }, 401)
  }

  if (!session.user.id) {
    console.error('Session user.id is undefined')
    return c.json({ error: 'Invalid session - user ID missing' }, 400)
  }

  // Can only disconnect if user didn't sign in with GitHub
  if (session.authProvider === 'github') {
    return c.json({ error: 'Cannot disconnect primary authentication method' }, 400)
  }

  try {
    await getDb().accounts.delete(session.user.id, 'github')
    return c.json({ success: true })
  } catch (error) {
    console.error('Error disconnecting GitHub:', error)
    return c.json({ error: 'Failed to disconnect' }, 500)
  }
})

export default githubAuth
