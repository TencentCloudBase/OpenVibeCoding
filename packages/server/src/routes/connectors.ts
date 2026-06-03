import { Hono } from 'hono'
import { getDb } from '../db/index.js'
import { nanoid } from 'nanoid'
import { encrypt, decrypt } from '../lib/crypto'
import { requireAuth, type AppEnv } from '../middleware/auth'

const app = new Hono<AppEnv>()

// GET /api/connectors - List all connectors for user
app.get('/', async (c) => {
  try {
    const authErr = requireAuth(c)
    if (authErr) return authErr
    const session = c.get('session')!
    const userId = session.user.id

    const userConnectors = await getDb().connectors.findByUserId(userId)

    const decryptedConnectors = userConnectors.map((connector) => ({
      ...connector,
      oauthClientSecret: connector.oauthClientSecret ? decrypt(connector.oauthClientSecret) : null,
      env: connector.env ? JSON.parse(decrypt(connector.env)) : null,
      headers: connector.headers ? JSON.parse(decrypt(connector.headers)) : null,
      args: connector.args ? JSON.parse(connector.args) : null,
    }))

    return c.json({
      success: true,
      data: decryptedConnectors,
    })
  } catch (error) {
    console.error('Error fetching connectors:', error)
    return c.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to fetch connectors',
        data: [],
      },
      { status: 500 },
    )
  }
})

// POST /api/connectors - Create connector
app.post('/', async (c) => {
  try {
    const authErr = requireAuth(c)
    if (authErr) return authErr
    const session = c.get('session')!
    const userId = session.user.id

    const body = await c.req.json()

    const connectorData = {
      id: nanoid(),
      userId,
      name: body.name,
      description: body.description?.trim() || undefined,
      type: body.type || 'remote',
      baseUrl: body.baseUrl?.trim() || undefined,
      oauthClientId: body.oauthClientId?.trim() || undefined,
      oauthClientSecret: body.oauthClientSecret?.trim() || undefined,
      command: body.command?.trim() || undefined,
      args: Array.isArray(body.args) && body.args.length > 0 ? body.args : undefined,
      env: body.env,
      headers: body.headers,
      status: 'connected' as const,
    }

    await getDb().connectors.create({
      id: connectorData.id,
      userId: connectorData.userId,
      name: connectorData.name,
      description: connectorData.description || null,
      type: connectorData.type as 'local' | 'remote',
      baseUrl: connectorData.baseUrl || null,
      oauthClientId: connectorData.oauthClientId || null,
      oauthClientSecret: connectorData.oauthClientSecret ? encrypt(connectorData.oauthClientSecret) : null,
      command: connectorData.command || null,
      args: connectorData.args ? JSON.stringify(connectorData.args) : null,
      env: connectorData.env ? encrypt(JSON.stringify(connectorData.env)) : null,
      headers: connectorData.headers ? encrypt(JSON.stringify(connectorData.headers)) : null,
      status: connectorData.status,
    })

    return c.json({
      success: true,
      message: 'Connector created successfully',
      data: { id: connectorData.id },
    })
  } catch (error) {
    console.error('Error creating connector:', error)
    return c.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to create connector',
      },
      { status: 500 },
    )
  }
})

// PATCH /api/connectors/:id - Update connector
app.patch('/:id', async (c) => {
  try {
    const authErr = requireAuth(c)
    if (authErr) return authErr
    const session = c.get('session')!
    const userId = session.user.id
    const id = c.req.param('id')

    const body = await c.req.json()

    const connectorData = {
      userId,
      name: body.name,
      description: body.description?.trim() || undefined,
      type: body.type || 'remote',
      baseUrl: body.baseUrl?.trim() || undefined,
      oauthClientId: body.oauthClientId?.trim() || undefined,
      oauthClientSecret: body.oauthClientSecret?.trim() || undefined,
      command: body.command?.trim() || undefined,
      args: Array.isArray(body.args) && body.args.length > 0 ? body.args : undefined,
      env: body.env,
      headers: body.headers,
      status: body.status || 'connected',
    }

    const validatedData = connectorData

    await getDb().connectors.update(id, userId, {
      name: validatedData.name,
      description: validatedData.description || null,
      type: validatedData.type as 'local' | 'remote',
      baseUrl: validatedData.baseUrl || null,
      oauthClientId: validatedData.oauthClientId || null,
      oauthClientSecret: validatedData.oauthClientSecret ? encrypt(validatedData.oauthClientSecret) : null,
      command: validatedData.command || null,
      args: validatedData.args ? JSON.stringify(validatedData.args) : null,
      env: validatedData.env ? encrypt(JSON.stringify(validatedData.env)) : null,
      headers: validatedData.headers ? encrypt(JSON.stringify(validatedData.headers)) : null,
      status: validatedData.status as 'connected' | 'disconnected',
      updatedAt: Date.now(),
    })

    return c.json({
      success: true,
      message: 'Connector updated successfully',
    })
  } catch (error) {
    console.error('Error updating connector:', error)
    return c.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to update connector',
      },
      { status: 500 },
    )
  }
})

// DELETE /api/connectors/:id - Delete connector
app.delete('/:id', async (c) => {
  try {
    const authErr = requireAuth(c)
    if (authErr) return authErr
    const session = c.get('session')!
    const userId = session.user.id
    const id = c.req.param('id')

    await getDb().connectors.delete(id, userId)

    return c.json({
      success: true,
      message: 'Connector deleted successfully',
    })
  } catch (error) {
    console.error('Error deleting connector:', error)

    return c.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to delete connector',
      },
      { status: 500 },
    )
  }
})

// PATCH /api/connectors/:id/status - Toggle connector status
app.patch('/:id/status', async (c) => {
  try {
    const authErr = requireAuth(c)
    if (authErr) return authErr
    const session = c.get('session')!
    const userId = session.user.id
    const id = c.req.param('id')
    const body = await c.req.json()
    const status = body.status as 'connected' | 'disconnected'

    if (!['connected', 'disconnected'].includes(status)) {
      return c.json(
        {
          success: false,
          error: 'Invalid status',
        },
        { status: 400 },
      )
    }

    await getDb().connectors.update(id, userId, { status })

    return c.json({
      success: true,
      message: `Connector ${status === 'connected' ? 'connected' : 'disconnected'} successfully`,
    })
  } catch (error) {
    console.error('Error toggling connector status:', error)

    return c.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to update connector status',
      },
      { status: 500 },
    )
  }
})

export default app
