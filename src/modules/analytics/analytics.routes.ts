import { Router } from 'express'
import type { RowDataPacket } from 'mysql2'
import { z } from 'zod'
import { pool } from '../../config/db'
import { authenticate } from '../../middleware/authenticate'
import { requireAnyPermission } from '../../middleware/authorize'
import { asyncHandler } from '../../utils/asyncHandler'
import { ok } from '../../utils/http'

const router = Router()
router.use(authenticate, requireAnyPermission('analytics.limited', 'analytics.read'))

const rangeSchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
})

function rangeWhere(from?: string, to?: string) {
  const where: string[] = ['sr.deleted_at IS NULL']
  const params: any[] = []
  if (from) { where.push('sr.created_at >= ?'); params.push(`${from} 00:00:00`) }
  if (to) { where.push('sr.created_at < DATE_ADD(?, INTERVAL 1 DAY)'); params.push(`${to} 00:00:00`) }
  return { where, params }
}

router.get('/requests/summary', asyncHandler(async (req, res) => {
  const q = rangeSchema.parse(req.query); const r = rangeWhere(q.from, q.to)
  const [rows] = await pool.execute<RowDataPacket[]>(
    `SELECT COUNT(*) AS total,
            SUM(sr.status IN ('RESOLVED','CLOSED')) AS resolved,
            SUM(sr.status NOT IN ('RESOLVED','CLOSED','REJECTED','CANCELLED','DUPLICATE')) AS open,
            AVG(CASE WHEN sr.resolved_at IS NOT NULL THEN TIMESTAMPDIFF(HOUR, sr.created_at, sr.resolved_at) END) AS averageResolutionHours
       FROM service_requests sr WHERE ${r.where.join(' AND ')}`, r.params)
  return ok(res, rows[0] ?? {})
}))

router.get('/requests/trend', asyncHandler(async (req, res) => {
  const q = rangeSchema.extend({ bucket: z.enum(['day','month']).default('day') }).parse(req.query); const r = rangeWhere(q.from, q.to)
  const format = q.bucket === 'month' ? '%Y-%m' : '%Y-%m-%d'
  const [rows] = await pool.execute<RowDataPacket[]>(
    `SELECT DATE_FORMAT(sr.created_at, '${format}') AS period, COUNT(*) AS created,
            SUM(sr.status IN ('RESOLVED','CLOSED')) AS resolved
       FROM service_requests sr WHERE ${r.where.join(' AND ')} GROUP BY period ORDER BY period`, r.params)
  return ok(res, rows)
}))

router.get('/requests/by-type', asyncHandler(async (req, res) => {
  const q = rangeSchema.parse(req.query); const r = rangeWhere(q.from, q.to)
  const [rows] = await pool.execute<RowDataPacket[]>(`SELECT sr.type, COUNT(*) AS count FROM service_requests sr WHERE ${r.where.join(' AND ')} GROUP BY sr.type ORDER BY count DESC`, r.params)
  return ok(res, rows)
}))

router.get('/requests/by-status', asyncHandler(async (req, res) => {
  const q = rangeSchema.parse(req.query); const r = rangeWhere(q.from, q.to)
  const [rows] = await pool.execute<RowDataPacket[]>(`SELECT sr.status, COUNT(*) AS count FROM service_requests sr WHERE ${r.where.join(' AND ')} GROUP BY sr.status ORDER BY count DESC`, r.params)
  return ok(res, rows)
}))

router.get('/departments', asyncHandler(async (_req, res) => {
  const [rows] = await pool.execute<RowDataPacket[]>(
    `SELECT d.id AS departmentId, d.name,
            COUNT(sr.id) AS total,
            SUM(sr.status IN ('RESOLVED','CLOSED')) AS resolved,
            SUM(sr.status NOT IN ('RESOLVED','CLOSED','REJECTED','CANCELLED','DUPLICATE')) AS open,
            AVG(CASE WHEN sr.resolved_at IS NOT NULL THEN TIMESTAMPDIFF(HOUR, sr.created_at, sr.resolved_at) END) AS averageResolutionHours
       FROM departments d LEFT JOIN service_requests sr ON sr.department_id = d.id AND sr.deleted_at IS NULL
      WHERE d.active = 1 GROUP BY d.id, d.name ORDER BY d.name`)
  return ok(res, rows)
}))

router.get('/wards', asyncHandler(async (_req, res) => {
  const [rows] = await pool.execute<RowDataPacket[]>(
    `SELECT w.id AS wardId, w.name, COUNT(sr.id) AS total,
            SUM(sr.status NOT IN ('RESOLVED','CLOSED','REJECTED','CANCELLED','DUPLICATE')) AS active
       FROM wards w LEFT JOIN service_requests sr ON sr.ward_id = w.id AND sr.deleted_at IS NULL
      WHERE w.active = 1 GROUP BY w.id, w.name ORDER BY w.code`)
  return ok(res, rows)
}))

router.get('/hotspots', asyncHandler(async (_req, res) => {
  const [rows] = await pool.execute<RowDataPacket[]>(
    `SELECT COALESCE(sr.location_label, w.name, 'Unknown') AS location, COUNT(*) AS reports
       FROM service_requests sr LEFT JOIN wards w ON w.id = sr.ward_id
      WHERE sr.deleted_at IS NULL GROUP BY COALESCE(sr.location_label, w.name, 'Unknown')
      ORDER BY reports DESC LIMIT 20`)
  return ok(res, rows)
}))

export default router
