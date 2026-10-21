import { Router } from 'express'
import type { RowDataPacket } from '../../config/db'
import { pool } from '../../config/db'
import { authenticate } from '../../middleware/authenticate'
import { asyncHandler } from '../../utils/asyncHandler'
import { ok } from '../../utils/http'

const router = Router()
router.use(authenticate)

router.get('/', asyncHandler(async (_req, res) => {
  const [rows] = await pool.execute<RowDataPacket[]>('SELECT id, code, name, description FROM departments WHERE active = true ORDER BY name')
  return ok(res, rows)
}))

router.get('/wards', asyncHandler(async (_req, res) => {
  const [rows] = await pool.execute<RowDataPacket[]>('SELECT id, code, name FROM wards WHERE active = true ORDER BY code')
  return ok(res, rows)
}))

export default router
