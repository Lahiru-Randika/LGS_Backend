import crypto from 'node:crypto'
import { Router } from 'express'
import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import { z } from 'zod'

import { pool, withTransaction } from '../../config/db'
import { authenticate } from '../../middleware/authenticate'
import { writeAudit } from '../../services/audit.service'
import { createNotification } from '../../services/notification.service'
import { asyncHandler } from '../../utils/asyncHandler'
import { badRequest, conflict, forbidden, notFound } from '../../utils/errors'
import { created, ok } from '../../utils/http'
import { routeParam } from '../../utils/routeParam'

const router = Router()
router.use(authenticate)

/* =========================================================
   LIST BOOKINGS
   - Citizens see their own bookings.
   - Field Officers (GOV_WORKER) only see bookings assigned to them.
   - GOV_ADMIN, APPROVER, SUPERIOR see all municipal bookings.
========================================================= */
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const role = req.authUser!.role
    const isCitizen = role === 'CITIZEN'
    const isWorker = role === 'GOV_WORKER'

    const where: string[] = []
    const params: any[] = []

    if (isCitizen) {
      where.push('(bd.user_id = ? OR sr.created_by_user_id = ?)')
      params.push(req.authUser!.id, req.authUser!.id)
    } else if (isWorker) {
      // Field officers should NOT see all bookings; only if assigned via service request
      where.push('sr.assigned_to_user_id = ?')
      params.push(req.authUser!.id)
    }

    // Optional query filters
    const qFacility = req.query.facilityId ? Number(req.query.facilityId) : null
    const qFacilityCode = req.query.facilityCode ? String(req.query.facilityCode).trim() : null
    const qStatus = req.query.status ? String(req.query.status).trim() : null
    const qStartDate = req.query.startDate ? String(req.query.startDate).trim() : null
    const qEndDate = req.query.endDate ? String(req.query.endDate).trim() : null

    if (qFacility) {
      where.push('bd.facility_building_id = ?')
      params.push(qFacility)
    }
    if (qFacilityCode) {
      where.push('b.building_code = ?')
      params.push(qFacilityCode)
    }
    if (qStatus && qStatus !== 'ALL') {
      where.push('bd.status = ?')
      params.push(qStatus)
    }
    if (qStartDate) {
      where.push('bd.booking_date >= ?')
      params.push(qStartDate)
    }
    if (qEndDate) {
      where.push('bd.booking_date <= ?')
      params.push(qEndDate)
    }

    const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''

    const [rows] = await pool.execute<RowDataPacket[]>(
      `SELECT
         bd.id AS idNum,
         COALESCE(bd.booking_code, sr.request_code, CONCAT('BK-', LPAD(bd.id, 4, '0'))) AS id,
         COALESCE(bd.booking_code, sr.request_code, CONCAT('BK-', LPAD(bd.id, 4, '0'))) AS bookingCode,
         COALESCE(b.resolved_name, b.name, 'Municipal Facility') AS facility,
         COALESCE(b.resolved_name, b.name, 'Municipal Facility') AS facilityName,
         b.id AS facilityBuildingId,
         b.id AS facilityId,
         b.building_code AS facilityCode,
         COALESCE(b.address, 'Colombo Municipal Council') AS location,
         DATE_FORMAT(bd.booking_date, '%d %b %Y') AS date,
         DATE_FORMAT(bd.booking_date, '%Y-%m-%d') AS dateIso,
         bd.booking_date AS rawDate,
         CASE
           WHEN bd.start_time IS NOT NULL AND bd.end_time IS NOT NULL THEN
             CONCAT(TIME_FORMAT(bd.start_time, '%h:%i %p'), ' – ', TIME_FORMAT(bd.end_time, '%h:%i %p'))
           WHEN bd.start_time IS NOT NULL THEN
             TIME_FORMAT(bd.start_time, '%h:%i %p')
           ELSE
             'Full Day'
         END AS time,
         TIME_FORMAT(bd.start_time, '%h:%i %p') AS startTime,
         TIME_FORMAT(bd.end_time, '%h:%i %p') AS endTime,
         TIME_FORMAT(bd.start_time, '%H:%i') AS rawStartTime,
         TIME_FORMAT(bd.end_time, '%H:%i') AS rawEndTime,
         bd.participants,
         bd.purpose,
         COALESCE(bd.status, 'PENDING') AS status,
         bd.created_at AS createdAt,
         COALESCE(u.display_name, 'Citizen User') AS citizenName,
         COALESCE(u.email, 'citizen@lgs.gov.lk') AS citizenEmail,
         u.public_id AS citizenPublicId
       FROM booking_details bd
       LEFT JOIN service_requests sr ON sr.id = bd.request_id AND sr.deleted_at IS NULL
       JOIN buildings b ON b.id = bd.facility_building_id
       LEFT JOIN users u ON u.id = COALESCE(bd.user_id, sr.created_by_user_id)
       ${whereClause}
       ORDER BY bd.booking_date ASC, bd.start_time ASC`,
      params,
    )

    return ok(res, rows)
  }),
)

/* =========================================================
   FACILITY AVAILABILITY
   GET /api/v1/bookings/availability?facilityId=X&date=YYYY-MM-DD
   Returns all reserved/locked slots to prevent overlapping bookings.
========================================================= */
router.get(
  '/availability',
  asyncHandler(async (req, res) => {
    const q = z
      .object({
        facilityId: z.coerce.number().int().positive().optional(),
        facilityCode: z.string().trim().optional(),
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      })
      .parse(req.query)

    let facilityId = q.facilityId
    if (!facilityId && q.facilityCode) {
      const [bRows] = await pool.execute<RowDataPacket[]>(
        'SELECT id FROM buildings WHERE building_code = ? LIMIT 1',
        [q.facilityCode],
      )
      facilityId = bRows[0]?.id
    }

    if (!facilityId) {
      return ok(res, { available: true, bookedSlots: [] })
    }

    const [rows] = await pool.execute<RowDataPacket[]>(
      `SELECT
         bd.id,
         COALESCE(bd.booking_code, sr.request_code, CONCAT('BK-', LPAD(bd.id, 4, '0'))) AS bookingCode,
         TIME_FORMAT(bd.start_time, '%H:%i') AS startTime,
         TIME_FORMAT(bd.end_time, '%H:%i') AS endTime,
         TIME_FORMAT(bd.start_time, '%h:%i %p') AS startTimeFormatted,
         TIME_FORMAT(bd.end_time, '%h:%i %p') AS endTimeFormatted,
         CONCAT(TIME_FORMAT(bd.start_time, '%h:%i %p'), ' – ', TIME_FORMAT(bd.end_time, '%h:%i %p')) AS timeFormatted,
         COALESCE(bd.status, 'CONFIRMED') AS status,
         bd.purpose
       FROM booking_details bd
       LEFT JOIN service_requests sr ON sr.id = bd.request_id AND sr.deleted_at IS NULL
       WHERE bd.facility_building_id = ?
         AND bd.booking_date = ?
         AND bd.status NOT IN ('CANCELLED', 'REJECTED')
       ORDER BY bd.start_time ASC`,
      [facilityId, q.date],
    )

    return ok(res, {
      date: q.date,
      facilityId,
      bookedSlots: rows,
    })
  }),
)

/* =========================================================
   LIST BOOKABLE FACILITIES
========================================================= */
router.get(
  '/facilities',
  asyncHandler(async (_req, res) => {
    const [rows] = await pool.execute<RowDataPacket[]>(
      `SELECT
         b.id,
         b.building_code AS code,
         COALESCE(b.resolved_name, b.name) AS name,
         COALESCE(b.address, 'Colombo Municipal Council') AS address,
         p.capacity,
         TIME_FORMAT(p.opening_time, '%h:%i %p') AS openingTime,
         TIME_FORMAT(p.closing_time, '%h:%i %p') AS closingTime,
         p.description
       FROM buildings b
       JOIN public_facility_profiles p ON p.building_id = b.id AND p.active = 1
       WHERE b.public_facility = 1 AND p.bookable = 1 AND b.deleted_at IS NULL
       ORDER BY COALESCE(b.resolved_name, b.name)`,
    )

    return ok(res, rows)
  }),
)

/* =========================================================
   CREATE A BOOKING (WITH COLLISION & DOUBLE BOOKING PREVENTION)
========================================================= */
const createBookingSchema = z.object({
  facilityBuildingId: z.coerce.number().int().positive().optional(),
  facilityCode: z.string().trim().optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be in YYYY-MM-DD format'),
  startTime: z.string().trim().min(4).max(10),
  endTime: z.string().trim().min(4).max(10),
  participants: z.coerce.number().int().positive().max(100000).default(1),
  purpose: z.string().trim().max(500).optional(),
})

router.post(
  '/',
  asyncHandler(async (req, res) => {
    const input = createBookingSchema.parse(req.body)

    let facilityId = input.facilityBuildingId

    if (!facilityId && input.facilityCode) {
      const [bldRows] = await pool.execute<RowDataPacket[]>(
        'SELECT id FROM buildings WHERE building_code = ? AND deleted_at IS NULL LIMIT 1',
        [input.facilityCode],
      )
      facilityId = bldRows[0]?.id
    }

    if (!facilityId) {
      const [defRows] = await pool.execute<RowDataPacket[]>(
        `SELECT b.id FROM buildings b 
         JOIN public_facility_profiles p ON p.building_id = b.id 
         WHERE b.public_facility = 1 AND p.bookable = 1 LIMIT 1`,
      )
      facilityId = defRows[0]?.id
    }

    if (!facilityId) {
      throw badRequest('Please select a valid municipal facility.')
    }

    // Verify facility
    const [facRows] = await pool.execute<RowDataPacket[]>(
      `SELECT b.id, COALESCE(b.resolved_name, b.name) AS name, p.capacity
         FROM buildings b
         LEFT JOIN public_facility_profiles p ON p.building_id = b.id
        WHERE b.id = ? AND b.deleted_at IS NULL LIMIT 1`,
      [facilityId],
    )

    // Format start & end time
    const sTime = input.startTime.includes(':') && input.startTime.length === 5 ? `${input.startTime}:00` : input.startTime
    const eTime = input.endTime.includes(':') && input.endTime.length === 5 ? `${input.endTime}:00` : input.endTime

    if (sTime >= eTime) {
      throw badRequest('Booking end time must be after the start time.')
    }

    // Block past dates and past times
    const now = new Date()
    const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
    const currentTimeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:00`

    if (input.date < todayStr) {
      throw badRequest('Cannot book a facility for a past date. Please select today or a future date.')
    }
    if (input.date === todayStr && sTime < currentTimeStr) {
      throw badRequest('Cannot book a time slot in the past. Please choose a future time slot.')
    }

    /* =========================================================
       ATOMIC TRANSACTION WITH ROW LOCKING
       Guarantees collision prevention under 100+ concurrent users.
    ========================================================= */
    const { bookingCode, facility } = await withTransaction(async (connection) => {
      // 1. Lock the facility row to serialize concurrent booking attempts
      const [facRows] = await connection.execute<RowDataPacket[]>(
        `SELECT b.id, COALESCE(b.resolved_name, b.name) AS name, p.capacity
           FROM buildings b
           LEFT JOIN public_facility_profiles p ON p.building_id = b.id
          WHERE b.id = ? AND b.deleted_at IS NULL LIMIT 1 FOR UPDATE`,
        [facilityId],
      )

      const facilityRow = facRows[0]
      if (!facilityRow) {
        throw notFound('Selected facility not found.')
      }

      // 2. Collision check inside transaction with row lock
      const [collisions] = await connection.execute<RowDataPacket[]>(
        `SELECT bd.id,
                COALESCE(bd.booking_code, CONCAT('BK-', LPAD(bd.id, 4, '0'))) AS bookingCode,
                COALESCE(b.resolved_name, b.name) AS facilityName,
                TIME_FORMAT(bd.start_time, '%h:%i %p') AS startFormatted,
                TIME_FORMAT(bd.end_time, '%h:%i %p') AS endFormatted
           FROM booking_details bd
           JOIN buildings b ON b.id = bd.facility_building_id
          WHERE bd.facility_building_id = ?
            AND bd.booking_date = ?
            AND bd.status NOT IN ('CANCELLED', 'REJECTED')
            AND (bd.start_time IS NULL OR bd.end_time IS NULL OR (bd.start_time < ? AND bd.end_time > ?))
          FOR UPDATE`,
        [facilityId, input.date, eTime, sTime],
      )

      if (collisions.length > 0) {
        const existing = collisions[0]
        const slotText = existing.startFormatted && existing.endFormatted
          ? `${existing.startFormatted} – ${existing.endFormatted}`
          : 'Full Day'
        throw conflict(
          `This premises is already booked for the selected time slot (${slotText}). Please choose another time slot or facility.`,
        )
      }

      // 3. Atomically insert into booking_details to obtain an unambiguous, monotonically unique auto-increment id
      const [result] = await connection.execute<ResultSetHeader>(
        `INSERT INTO booking_details
          (booking_code, user_id, facility_building_id, booking_date, start_time, end_time, participants, purpose, status, created_at, updated_at)
         VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, 'CONFIRMED', UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
        [
          req.authUser!.id,
          facilityId,
          input.date,
          sTime,
          eTime,
          input.participants,
          input.purpose || 'Municipal facility booking',
        ],
      )

      const insertId = result.insertId
      const year = new Date().getUTCFullYear()
      let code = `BK-${year}-${String(insertId + 20).padStart(4, '0')}`

      // Assign the unique booking code; retry with disambiguating suffix on duplicate key collision
      let attempts = 0
      while (attempts < 5) {
        try {
          await connection.execute(
            'UPDATE booking_details SET booking_code = ? WHERE id = ?',
            [code, insertId],
          )
          break
        } catch (err: any) {
          if (err?.code === 'ER_DUP_ENTRY' && attempts < 4) {
            attempts++
            code = `BK-${year}-${String(insertId + 20 + attempts).padStart(4, '0')}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`
          } else {
            throw err
          }
        }
      }

      return { bookingCode: code, facility: facilityRow }
    })

    // Notify user
    try {
      await createNotification({
        userId: req.authUser!.id,
        type: 'BOOKING_CONFIRMED',
        title: 'Booking Confirmed',
        body: `Your booking (${bookingCode}) for ${facility.name} on ${input.date} has been confirmed.`,
        entityType: 'BOOKING',
        entityId: bookingCode,
        tone: 'SUCCESS',
      })
    } catch {
      // Non-fatal
    }

    // Write audit log
    await writeAudit({
      actorUserId: req.authUser!.id,
      action: 'BOOKING_CREATED',
      entityType: 'BOOKING',
      entityId: bookingCode,
      afterData: {
        facilityId,
        facilityName: facility.name,
        date: input.date,
        startTime: input.startTime,
        endTime: input.endTime,
        participants: input.participants,
      },
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
      requestId: req.requestId,
    })

    return created(res, {
      bookingCode,
      id: bookingCode,
      status: 'CONFIRMED',
      facility: facility.name,
      message: 'Booking created successfully.',
    })
  }),
)

/* =========================================================
   ADMIN/OFFICER: UPDATE BOOKING STATUS
   PATCH /api/v1/bookings/:id/status
   Allowed for: GOV_ADMIN, APPROVER, SUPERIOR
========================================================= */
router.patch(
  '/:id/status',
  asyncHandler(async (req, res) => {
    if (!['GOV_ADMIN', 'APPROVER', 'SUPERIOR'].includes(req.authUser!.role)) {
      throw forbidden('Only municipal administrators and approvers can update booking status.')
    }

    const rawId = routeParam(req.params.id, 'id')
    const input = z
      .object({
        status: z.enum(['CONFIRMED', 'COMPLETED', 'CANCELLED', 'PENDING']),
        note: z.string().trim().max(1000).optional(),
      })
      .parse(req.body)

    const [rows] = await pool.execute<RowDataPacket[]>(
      `SELECT bd.id, bd.booking_code, bd.user_id, bd.status,
              COALESCE(b.resolved_name, b.name) AS facilityName
         FROM booking_details bd
         JOIN buildings b ON b.id = bd.facility_building_id
        WHERE (bd.booking_code = ? OR bd.id = ?) LIMIT 1`,
      [rawId, rawId],
    )

    const booking = rows[0]
    if (!booking) {
      throw notFound('Booking not found.')
    }

    await pool.execute(
      'UPDATE booking_details SET status = ?, updated_at = UTC_TIMESTAMP() WHERE id = ?',
      [input.status, booking.id],
    )

    if (booking.user_id) {
      try {
        await createNotification({
          userId: booking.user_id,
          type: 'BOOKING_STATUS_CHANGED',
          title: `Booking ${input.status}`,
          body: `Your booking (${booking.booking_code || booking.id}) for ${booking.facilityName} has been updated to ${input.status}.`,
          entityType: 'BOOKING',
          entityId: String(booking.booking_code || booking.id),
          tone: input.status === 'CONFIRMED' || input.status === 'COMPLETED' ? 'SUCCESS' : 'WARNING',
        })
      } catch {
        // Non-fatal
      }
    }

    await writeAudit({
      actorUserId: req.authUser!.id,
      action: 'BOOKING_STATUS_UPDATED',
      entityType: 'BOOKING',
      entityId: String(booking.booking_code || booking.id),
      afterData: { status: input.status, note: input.note },
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
      requestId: req.requestId,
    })

    return ok(res, { updated: true, status: input.status })
  }),
)

/* =========================================================
   CANCEL A BOOKING
========================================================= */
router.post(
  '/:id/cancel',
  asyncHandler(async (req, res) => {
    const rawId = routeParam(req.params.id, 'id')

    const [rows] = await pool.execute<RowDataPacket[]>(
      `SELECT bd.id, bd.booking_code, bd.user_id, bd.status 
         FROM booking_details bd 
        WHERE (bd.booking_code = ? OR bd.id = ?) LIMIT 1`,
      [rawId, rawId],
    )

    const booking = rows[0]
    if (!booking) {
      throw notFound('Booking not found.')
    }

    if (req.authUser!.role === 'CITIZEN' && booking.user_id !== req.authUser!.id) {
      throw notFound('Booking not found.')
    }

    await pool.execute(
      "UPDATE booking_details SET status = 'CANCELLED', updated_at = UTC_TIMESTAMP() WHERE id = ?",
      [booking.id],
    )

    await writeAudit({
      actorUserId: req.authUser!.id,
      action: 'BOOKING_CANCELLED',
      entityType: 'BOOKING',
      entityId: String(booking.booking_code || booking.id),
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
      requestId: req.requestId,
    })

    return ok(res, { cancelled: true, status: 'CANCELLED' })
  }),
)

export default router
