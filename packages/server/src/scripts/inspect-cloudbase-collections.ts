#!/usr/bin/env tsx
// List all vibe_agent_* collections with row counts and a sample row.
// Helps diagnose where users actually live.
//
// Usage: DB_PROVIDER=cloudbase npx tsx src/scripts/inspect-cloudbase-collections.ts

import 'dotenv/config'
import CloudBase from '@cloudbase/node-sdk'

async function main() {
  const envId = process.env.TCB_ENV_ID
  const region = process.env.TCB_REGION || 'ap-shanghai'
  const secretId = process.env.TCB_SECRET_ID
  const secretKey = process.env.TCB_SECRET_KEY
  const prefix = process.env.DB_COLLECTION_PREFIX || 'vibe_agent_'

  if (!envId || !secretId || !secretKey) {
    console.error('[inspect] Missing TCB_ENV_ID / TCB_SECRET_ID / TCB_SECRET_KEY')
    process.exit(1)
  }

  console.log(`[inspect] envId=${envId} region=${region} prefix=${prefix}`)
  const app = CloudBase.init({ env: envId, region, secretId, secretKey })
  const db = app.database()

  // Try a few known collections directly (no list-collections API exposed simply)
  const knownNames = [
    'users',
    'user',
    'User',
    'Users',
    'accounts',
    'account',
    'Account',
    'local_credentials',
    'localCredentials',
    'tasks',
    'sessions',
    'github_users',
    'auth_users',
  ]

  for (const name of knownNames) {
    const full = `${prefix}${name}`
    try {
      const col = db.collection(full)
      const { total } = await col.count()
      console.log(`[inspect] ${full}: total=${total}`)
      if (total > 0) {
        const { data } = await col.limit(3).get()
        for (const row of data) {
          // Mask sensitive fields
          const safe: any = { ...row }
          for (const k of Object.keys(safe)) {
            if (/secret|password|key|token/i.test(k)) safe[k] = '***'
          }
          console.log(`        sample: ${JSON.stringify(safe)}`)
        }
      }
    } catch (e: any) {
      console.log(`[inspect] ${full}: error=${e.message}`)
    }
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
