import { Hono } from 'hono'
import { setCookie } from 'hono/cookie'
import { getDb } from '../db/index.js'
import { nanoid } from 'nanoid'
import { encryptJWE } from '../lib/session'
import { encrypt } from '../lib/crypto'
import type { AppEnv, AppSession } from '../middleware/auth'
import { provisionUserResources } from '../cloudbase/provision.js'

const SESSION_COOKIE_NAME = 'nex_session'
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365 // 1 year in seconds

const cloudbaseAuth = new Hono<AppEnv>()

// POST /api/auth/cloudbase/login
// The frontend uses @cloudbase/js-sdk to do GitHub login via CloudBase identity source,
// then sends the resulting user info here to create a local session.
cloudbaseAuth.post('/login', async (c) => {
  try {
    const body = await c.req.json()
    const { uid, customUserId, nickName, email, avatarUrl } = body

    if (!uid || typeof uid !== 'string') {
      return c.json({ error: 'Missing CloudBase user ID' }, 400)
    }

    const now = Date.now()
    const externalId = uid
    const username = nickName || customUserId || `cb_${uid.slice(0, 8)}`

    // Upsert user
    const existing = await getDb().users.findByProviderAndExternalId('cloudbase', externalId)

    let userId: string
    if (existing) {
      if (existing.status === 'disabled') {
        return c.json({ error: 'Account has been disabled' }, 403)
      }
      userId = existing.id
      await getDb().users.update(userId, {
        email: email || null,
        name: nickName || null,
        avatarUrl: avatarUrl || null,
        updatedAt: now,
        lastLoginAt: now,
      })
    } else {
      userId = nanoid()
      const userCount = await getDb().users.count()
      await getDb().users.create({
        id: userId,
        provider: 'cloudbase',
        externalId,
        accessToken: '',
        username,
        email: email || undefined,
        name: nickName || undefined,
        avatarUrl: avatarUrl || undefined,
        role: userCount === 0 ? 'admin' : 'user',
        status: 'active',
        apiKey: encrypt(`sak_${nanoid(40)}`),
      })

      // Provision CloudBase resources for new user
      if (process.env.TCB_SECRET_ID && process.env.TCB_SECRET_KEY) {
        const resourceId = nanoid()
        const { getProvisionMode } = await import('../lib/provision-config.js')
        const provisionMode = await getProvisionMode()

        if (provisionMode === 'isolated') {
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
          provisionUserResources(userId, username)
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
        } else {
          await getDb().userResources.create({
            id: resourceId,
            userId,
            status: 'success',
            envId: process.env.TCB_ENV_ID || null,
            envAlias: null,
            envRegion: null,
            cosTagValue: null,
            policyHash: null,
            camUsername: null,
            camSecretId: process.env.TCB_SECRET_ID || null,
            camSecretKey: process.env.TCB_SECRET_KEY || null,
            policyId: null,
            failStep: null,
            failReason: null,
            createdAt: now,
            updatedAt: now,
          })
        }
      }
    }

    const session: AppSession = {
      created: now,
      authProvider: 'cloudbase',
      user: {
        id: userId,
        username,
        email: email || undefined,
        name: nickName || username,
        avatar:
          avatarUrl || `https://ui-avatars.com/api/?name=${encodeURIComponent(username)}&background=6366f1&color=fff`,
      },
    }

    const sessionValue = await encryptJWE(session, '1y')

    setCookie(c, SESSION_COOKIE_NAME, sessionValue, {
      path: '/',
      maxAge: COOKIE_MAX_AGE,
      httpOnly: true,
      sameSite: 'Lax',
      secure: process.env.NODE_ENV === 'production',
    })

    return c.json({ success: true, username })
  } catch (error) {
    console.error('CloudBase auth error:', error)
    return c.json({ error: 'Authentication failed' }, 500)
  }
})

export default cloudbaseAuth
