// Session types for compatibility with original components
export interface Session {
  created: number
  authProvider: 'github' | 'local' | 'cloudbase'
  user: {
    id: string
    username: string
    email?: string
    avatar?: string
    name?: string
    role: 'user' | 'admin'
  }
}

export interface Connector {
  id: string
  userId: string
  name: string
  description?: string | null
  type: 'HTTP' | 'SSE' | 'STDIO'
  baseUrl?: string | null
  oauthClientId?: string | null
  oauthClientSecret?: string | null
  command?: string | null
  args?: string[] | null
  env?: Record<string, string> | null
  headers?: Record<string, string> | null
  status: 'connected' | 'disconnected'
  createdAt: number
  updatedAt: number
}
