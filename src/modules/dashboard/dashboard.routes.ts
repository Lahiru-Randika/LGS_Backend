import { Router } from 'express'
import type { RowDataPacket } from '../../config/db'
import { pool } from '../../config/db'
import { authenticate } from '../../middleware/authenticate'
import { asyncHandler } from '../../utils/asyncHandler'
import { ok } from '../../utils/http'

const router = Router()
router.use(authenticate)

router.get('/', asyncHandler(async (req, res) => {
  const user = req.authUser!
  if (user.role === 'CITIZEN') {
    const [counts] = await pool.execute<(RowDataPacket & { total: number; openCount: number; resolvedCount: number; bookings: number })[]>(
      `SELECT COUNT(*) AS total,
              COUNT(*) FILTER (WHERE status NOT IN ('RESOLVED','CLOSED','REJECTED','CANCELLED','DUPLICATE')) AS "openCount",
              COUNT(*) FILTER (WHERE status IN ('RESOLVED','CLOSED')) AS "resolvedCount",
              COUNT(*) FILTER (WHERE type = 'BOOKING') AS bookings
         FROM service_requests WHERE created_by_user_id = ? AND deleted_at IS NULL`, [user.id])
    const [recent] = await pool.execute<RowDataPacket[]>(
      `SELECT request_code AS "requestCode", type, title, status, priority, location_label AS "locationLabel", created_at AS "createdAt"
         FROM service_requests WHERE created_by_user_id = ? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 8`, [user.id])
    return ok(res, { requestCounts: counts[0] ?? {}, recentRequests: recent })
  }

  if (user.role === 'GOV_WORKER') {
    const [counts] = await pool.execute<RowDataPacket[]>(
      `SELECT COUNT(*) AS assigned,
              COUNT(*) FILTER (WHERE priority IN ('HIGH','URGENT') AND status NOT IN ('RESOLVED','CLOSED')) AS "highPriority",
              COUNT(*) FILTER (WHERE (resolved_at AT TIME ZONE 'UTC')::date = (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date) AS "completedToday"
         FROM service_requests WHERE assigned_to_user_id = ? AND deleted_at IS NULL`, [user.id])
    const [assigned] = await pool.execute<RowDataPacket[]>(
      `SELECT request_code AS "requestCode", type, title, status, priority, location_label AS "locationLabel", updated_at AS "updatedAt"
         FROM service_requests WHERE assigned_to_user_id = ? AND deleted_at IS NULL AND status NOT IN ('CLOSED','REJECTED','CANCELLED','DUPLICATE')
         ORDER BY CASE priority WHEN 'URGENT' THEN 1 WHEN 'HIGH' THEN 2 WHEN 'NORMAL' THEN 3 WHEN 'LOW' THEN 4 ELSE 5 END, updated_at DESC LIMIT 12`, [user.id])
    return ok(res, { ...counts[0], assignedRequests: assigned })
  }

  if (user.role === 'APPROVER') {
    const [counts] = await pool.execute<RowDataPacket[]>(
      `SELECT COUNT(*) FILTER (WHERE status = 'PENDING') AS "awaitingDecision",
              ROUND(EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - MIN(CASE WHEN status = 'PENDING' THEN created_at END))) / 3600) AS "oldestWaitingHours",
              COUNT(*) FILTER (WHERE status = 'APPROVED' AND decided_at >= CURRENT_TIMESTAMP - INTERVAL '7 day') AS "approvedThisWeek"
         FROM approval_requests WHERE assigned_to_user_id IS NULL OR assigned_to_user_id = ?`, [user.id])
    const [pending] = await pool.execute<RowDataPacket[]>(
      `SELECT a.public_id AS id, sr.request_code AS "requestCode", sr.title, sr.priority, a.approval_type AS "approvalType", a.created_at AS "createdAt"
         FROM approval_requests a JOIN service_requests sr ON sr.id = a.request_id
        WHERE a.status = 'PENDING' AND (a.assigned_to_user_id IS NULL OR a.assigned_to_user_id = ?)
        ORDER BY a.created_at LIMIT 12`, [user.id])
    return ok(res, { ...counts[0], pendingApprovals: pending })
  }

  const [counts] = await pool.execute<RowDataPacket[]>(
    `SELECT COUNT(*) AS "totalRequests",
            COUNT(*) FILTER (WHERE status NOT IN ('RESOLVED','CLOSED','REJECTED','CANCELLED','DUPLICATE')) AS "openRequests",
            COUNT(*) FILTER (WHERE status IN ('RESOLVED','CLOSED')) AS "resolvedRequests",
            COUNT(*) FILTER (WHERE assigned_to_user_id IS NULL AND status NOT IN ('RESOLVED','CLOSED','REJECTED','CANCELLED','DUPLICATE')) AS unassigned,
            COUNT(*) FILTER (WHERE status = 'AWAITING_APPROVAL') AS "awaitingApproval"
       FROM service_requests WHERE deleted_at IS NULL`)
  const [recent] = await pool.execute<RowDataPacket[]>(
    `SELECT request_code AS "requestCode", type, title, status, priority, location_label AS "locationLabel", created_at AS "createdAt"
       FROM service_requests WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT 12`)
  return ok(res, { ...counts[0], recentRequests: recent })
}))

export default router
