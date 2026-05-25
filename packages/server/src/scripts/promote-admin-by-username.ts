#!/usr/bin/env tsx
// Promote a user to admin by username (or email).
// Usage:
//   DB_PROVIDER=cloudbase npx tsx src/scripts/promote-admin-by-username.ts <username>
//
// Note: scans all users; fine for small user tables. For large ones, prefer
// promote-admin.ts with a known userId.

import 'dotenv/config'
import { getDb } from '../db'

async function main(query: string) {
  const db = getDb()

  console.log(`[promote] DB_PROVIDER=${process.env.DB_PROVIDER}`)
  console.log(`[promote] TCB_ENV_ID=${process.env.TCB_ENV_ID}`)
  console.log(`[promote] DB_COLLECTION_PREFIX=${process.env.DB_COLLECTION_PREFIX || '(default vibe_agent_)'}`)

  const total = await db.users.count()
  console.log(`[promote] users.count() = ${total}`)

  // Pull a generous batch — admin tables are typically small.
  const users = await db.users.findAll(1000, 0)
  console.log(`[promote] users.findAll() returned ${users.length} rows`)

  const matched = users.filter((u) => u.username === query || u.email === query || u.externalId === query)

  if (matched.length === 0) {
    console.error(`[promote] No user found matching "${query}"`)
    console.error('[promote] Available usernames (first 20):')
    for (const u of users.slice(0, 20)) {
      console.error(`  - ${u.username}  (id=${u.id}, provider=${u.provider}, role=${u.role})`)
    }
    process.exit(1)
  }

  if (matched.length > 1) {
    console.error(`[promote] Ambiguous match (${matched.length} users):`)
    for (const u of matched) {
      console.error(`  - ${u.username}  (id=${u.id}, provider=${u.provider}, role=${u.role})`)
    }
    console.error('[promote] Use promote-admin.ts <userId> instead.')
    process.exit(1)
  }

  const user = matched[0]
  console.log(`[promote] Found user: ${user.username} (id=${user.id}, role=${user.role})`)

  if (user.role === 'admin') {
    console.log('[promote] Already admin, nothing to do.')
    process.exit(0)
  }

  await db.users.updateRole(user.id, 'admin')
  console.log(`[promote] OK — "${user.username}" promoted to admin.`)
  process.exit(0)
}

const [query] = process.argv.slice(2)
if (!query) {
  console.error('Usage: DB_PROVIDER=cloudbase npx tsx src/scripts/promote-admin-by-username.ts <username|email>')
  process.exit(1)
}

main(query)
