import crypto from 'node:crypto'
import { Router } from 'express'
import type { RowDataPacket } from 'mysql2'
import { z } from 'zod'
import { pool } from '../../config/db'
import { publicFormRateLimit } from '../../middleware/rateLimits'
import { asyncHandler } from '../../utils/asyncHandler'
import { created, ok } from '../../utils/http'
import { notFound } from '../../utils/errors'

const router = Router()

router.get('/buildings', asyncHandler(async (req, res) => {
  const q = z.object({
    search: z.string().trim().max(200).optional(),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(30),
  }).parse(req.query)
  const where = ['b.active = 1', 'b.deleted_at IS NULL']
  const params: any[] = []
  if (q.search) {
    where.push('(b.building_code LIKE ? OR b.name LIKE ? OR b.resolved_name LIKE ? OR b.address LIKE ?)')
    params.push(...Array(4).fill(`%${q.search}%`))
  }
  const offset = (q.page - 1) * q.limit
  const [rows] = await pool.execute<RowDataPacket[]>(
    `SELECT b.building_code AS buildingCode, COALESCE(b.resolved_name,b.name) AS name, b.address,
            b.building_type AS buildingType, b.public_facility AS publicFacility, b.latitude, b.longitude
       FROM buildings b WHERE ${where.join(' AND ')}
      ORDER BY COALESCE(b.resolved_name,b.name,b.building_code) LIMIT ? OFFSET ?`, [...params, q.limit, offset])
  return ok(res, rows)
}))

router.get('/buildings/:code', asyncHandler(async (req, res) => {
  const [rows] = await pool.execute<RowDataPacket[]>(
    `SELECT b.building_code AS buildingCode, COALESCE(b.resolved_name,b.name) AS name, b.address,
            b.building_type AS buildingType, b.public_facility AS publicFacility, b.latitude, b.longitude
       FROM buildings b WHERE b.building_code = ? AND b.active = 1 AND b.deleted_at IS NULL LIMIT 1`, [req.params.code])
  if (!rows[0]) throw notFound('Building not found.')
  return ok(res, rows[0])
}))

router.get('/facilities', asyncHandler(async (_req, res) => {
  const [rows] = await pool.execute<RowDataPacket[]>(
    `SELECT b.building_code AS buildingCode, COALESCE(b.resolved_name,b.name) AS name, b.address,
            b.latitude, b.longitude, f.bookable, f.capacity, f.opening_time AS openingTime,
            f.closing_time AS closingTime, f.description
       FROM buildings b
       LEFT JOIN public_facility_profiles f ON f.building_id = b.id AND f.active = 1
      WHERE b.public_facility = 1 AND b.active = 1 AND b.deleted_at IS NULL
      ORDER BY COALESCE(b.resolved_name,b.name,b.building_code)`)
  return ok(res, rows)
}))

router.get('/facilities/:code', asyncHandler(async (req, res) => {
  const [rows] = await pool.execute<RowDataPacket[]>(
    `SELECT b.building_code AS buildingCode, COALESCE(b.resolved_name,b.name) AS name, b.address,
            b.latitude, b.longitude, f.bookable, f.capacity, f.opening_time AS openingTime,
            f.closing_time AS closingTime, f.booking_requires_approval AS bookingRequiresApproval,
            f.advance_booking_days AS advanceBookingDays, f.minimum_notice_hours AS minimumNoticeHours, f.description
       FROM buildings b LEFT JOIN public_facility_profiles f ON f.building_id = b.id AND f.active = 1
      WHERE b.building_code = ? AND b.public_facility = 1 AND b.active = 1 AND b.deleted_at IS NULL LIMIT 1`, [req.params.code])
  if (!rows[0]) throw notFound('Public facility not found.')
  return ok(res, rows[0])
}))

router.get('/facilities/:code/availability', asyncHandler(async (req, res) => {
  const q = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).parse(req.query)
  const [buildings] = await pool.execute<(RowDataPacket & { id: number; capacity: number | null; bookable: number | null })[]>(
    `SELECT b.id, f.capacity, f.bookable FROM buildings b
       LEFT JOIN public_facility_profiles f ON f.building_id = b.id AND f.active = 1
      WHERE b.building_code = ? AND b.public_facility = 1 AND b.active = 1 AND b.deleted_at IS NULL LIMIT 1`, [req.params.code])
  const facility = buildings[0]
  if (!facility) throw notFound('Public facility not found.')
  const [bookings] = await pool.execute<RowDataPacket[]>(
    `SELECT bd.start_time AS startTime, bd.end_time AS endTime, bd.participants, bd.status, sr.request_code AS requestCode
       FROM booking_details bd JOIN service_requests sr ON sr.id = bd.request_id
      WHERE bd.facility_building_id = ? AND bd.booking_date = ? AND bd.status IN ('PENDING','APPROVED') AND sr.deleted_at IS NULL
      ORDER BY bd.start_time`, [facility.id, q.date])
  return ok(res, { available: facility.bookable !== 0, capacity: facility.capacity, existingBookings: bookings })
}))

router.get('/news', asyncHandler(async (_req, res) => {
  const [rows] = await pool.execute<RowDataPacket[]>(
    `SELECT public_id AS id, slug, category, title, summary, cover_image_key AS coverImageKey, published_at AS publishedAt
       FROM news_posts WHERE status = 'PUBLISHED' AND published_at <= UTC_TIMESTAMP()
      ORDER BY published_at DESC LIMIT 50`)
  return ok(res, rows)
}))

router.get('/news/:slug', asyncHandler(async (req, res) => {
  const [rows] = await pool.execute<RowDataPacket[]>(
    `SELECT public_id AS id, slug, category, title, summary, body, cover_image_key AS coverImageKey, published_at AS publishedAt
       FROM news_posts WHERE slug = ? AND status = 'PUBLISHED' AND published_at <= UTC_TIMESTAMP() LIMIT 1`, [req.params.slug])
  if (!rows[0]) throw notFound('News post not found.')
  return ok(res, rows[0])
}))

router.post('/contact', publicFormRateLimit, asyncHandler(async (req, res) => {
  const input = z.object({
    name: z.string().trim().min(2).max(200),
    email: z.string().email().max(255).transform((v) => v.toLowerCase()),
    subject: z.string().trim().min(2).max(255),
    message: z.string().trim().min(10).max(5000),
  }).parse(req.body)
  const id = crypto.randomUUID()
  await pool.execute(
    `INSERT INTO contact_messages (public_id, name, email, subject, message, status, created_at)
     VALUES (?, ?, ?, ?, ?, 'NEW', UTC_TIMESTAMP())`, [id, input.name, input.email, input.subject, input.message])
  return created(res, { id, received: true })
}))

export default router
