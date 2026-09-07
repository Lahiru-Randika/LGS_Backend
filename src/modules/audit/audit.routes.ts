import { Router } from 'express'
import type { RowDataPacket } from 'mysql2'
import { z } from 'zod'
import { pool } from '../../config/db'
import { authenticate } from '../../middleware/authenticate'
import { requirePermission } from '../../middleware/authorize'
import { asyncHandler } from '../../utils/asyncHandler'
import { ok } from '../../utils/http'

const router = Router()
router.use(authenticate, requirePermission('audit.read'))

router.get('/', asyncHandler(async (req, res) => {
  const q = z.object({
    action: z.string().trim().max(100).optional(),
    entityType: z.string().trim().max(80).optional(),
    entityId: z.string().trim().max(100).optional(),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  }).parse(req.query)

  const where = ['1=1']
  const params: any[] = []
  if (q.action) { where.push('a.action = ?'); params.push(q.action) }
  if (q.entityType) { where.push('a.entity_type = ?'); params.push(q.entityType) }
  if (q.entityId) { where.push('a.entity_id = ?'); params.push(q.entityId) }
  const offset = (q.page - 1) * q.limit
  const [rows] = await pool.execute<RowDataPacket[]>(
    `SELECT a.id, a.action, a.entity_type AS entityType, a.entity_id AS entityId,
            a.before_data AS beforeData, a.after_data AS afterData,
            actor.public_id AS actorId, actor.display_name AS actorName,
            a.ip_address AS ipAddress, a.request_id AS requestId, a.created_at AS createdAt
       FROM audit_logs a LEFT JOIN users actor ON actor.id = a.actor_user_id
      WHERE ${where.join(' AND ')} ORDER BY a.created_at DESC LIMIT ? OFFSET ?`,
    [...params, q.limit, offset],
  )
  const [countRows] = await pool.execute<(RowDataPacket & { total: number })[]>(
    `SELECT COUNT(*) AS total FROM audit_logs a WHERE ${where.join(' AND ')}`, params)
  return ok(res, rows, { page: q.page, limit: q.limit, total: countRows[0]?.total ?? 0 })
}))

export default router
