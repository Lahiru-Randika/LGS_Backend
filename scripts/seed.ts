import crypto from 'node:crypto'
import argon2 from 'argon2'
import type { RowDataPacket } from 'mysql2'
import { pool } from '../src/config/db'
import { env } from '../src/config/env'

interface RoleRow extends RowDataPacket { id: number }
interface UserRow extends RowDataPacket { id: number }

async function main() {
  if (!env.BOOTSTRAP_SUPERIOR_EMAIL || !env.BOOTSTRAP_SUPERIOR_PASSWORD) {
    console.log('Reference data is already seeded by migrations. No bootstrap superior credentials were supplied; skipping privileged-user bootstrap.')
    return
  }

  const [roles] = await pool.execute<RoleRow[]>('SELECT id FROM roles WHERE code = ? LIMIT 1', ['SUPERIOR'])
  const roleId = roles[0]?.id
  if (!roleId) throw new Error('SUPERIOR role not found. Run migrations first.')

  const [existing] = await pool.execute<UserRow[]>('SELECT id FROM users WHERE email = ? LIMIT 1', [env.BOOTSTRAP_SUPERIOR_EMAIL.toLowerCase()])
  if (existing[0]) {
    console.log('Bootstrap superior already exists; no change made.')
    return
  }

  const parts = env.BOOTSTRAP_SUPERIOR_NAME.trim().split(/\s+/)
  const firstName = parts.shift() || 'Initial'
  const lastName = parts.join(' ') || 'Superior'
  const hash = await argon2.hash(env.BOOTSTRAP_SUPERIOR_PASSWORD, { type: argon2.argon2id })

  await pool.execute(
    `INSERT INTO users
      (public_id, first_name, last_name, display_name, email, password_hash, role_id, status, email_verified_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'ACTIVE', UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
    [crypto.randomUUID(), firstName, lastName, env.BOOTSTRAP_SUPERIOR_NAME, env.BOOTSTRAP_SUPERIOR_EMAIL.toLowerCase(), hash, roleId],
  )
  console.log(`Bootstrap SUPERIOR created: ${env.BOOTSTRAP_SUPERIOR_EMAIL}`)
  console.log('Change the bootstrap password immediately after first login.')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
}).finally(async () => {
  await pool.end()
})
