import type { PoolConnection } from 'mysql2/promise'
import { pool } from '../config/db'

export async function writeAudit(input: {
  actorUserId?: number | null
  action: string
  entityType: string
  entityId?: string | number | null
  beforeData?: unknown
  afterData?: unknown
  ipAddress?: string | null
  userAgent?: string | null
  requestId?: string | null
}, connection?: PoolConnection) {
  const runner = connection ?? pool
  await runner.execute(
    `INSERT INTO audit_logs
      (actor_user_id, action, entity_type, entity_id, before_data, after_data, ip_address, user_agent, request_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP())`,
    [
      input.actorUserId ?? null,
      input.action,
      input.entityType,
      input.entityId != null ? String(input.entityId) : null,
      input.beforeData === undefined ? null : JSON.stringify(input.beforeData),
      input.afterData === undefined ? null : JSON.stringify(input.afterData),
      input.ipAddress ?? null,
      input.userAgent?.slice(0, 500) ?? null,
      input.requestId ?? null,
    ],
  )
}
