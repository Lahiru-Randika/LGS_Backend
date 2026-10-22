import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { Router } from 'express'
import type { ResultSetHeader, RowDataPacket } from '../../config/db'
import { z } from 'zod'

import { pool, withTransaction } from '../../config/db'
import { env } from '../../config/env'
import { authenticate } from '../../middleware/authenticate'
import { upload } from '../../middleware/upload'
import { writeAudit } from '../../services/audit.service'
import { createNotification } from '../../services/notification.service'
import { asyncHandler } from '../../utils/asyncHandler'
import { badRequest, conflict, forbidden, notFound } from '../../utils/errors'
import { created, ok } from '../../utils/http'
import { routeParam } from '../../utils/routeParam'

const router = Router()
router.use(authenticate)

const PRIVILEGED_FACILITY_ROLES = ['GOV_ADMIN', 'APPROVER', 'SUPERIOR']

/* =========================================================
   1. LIST BOOKINGS
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
      where.push('bd.booking_date >= ?::DATE')
      params.push(qStartDate)
    }
    if (qEndDate) {
      where.push('bd.booking_date <= ?::DATE')
      params.push(qEndDate)
    }

    const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''

    const [rows] = await pool.execute<RowDataPacket[]>(
      `SELECT
         bd.id AS "idNum",
         COALESCE(bd.booking_code, sr.request_code, CONCAT('BK-', LPAD(bd.id::text, 4, '0'))) AS id,
         COALESCE(bd.booking_code, sr.request_code, CONCAT('BK-', LPAD(bd.id::text, 4, '0'))) AS "bookingCode",
         COALESCE(b.resolved_name, b.name, 'Municipal Facility') AS facility,
         COALESCE(b.resolved_name, b.name, 'Municipal Facility') AS "facilityName",
         b.id AS "facilityBuildingId",
         b.id AS "facilityId",
         b.building_code AS "facilityCode",
         COALESCE(b.address, 'Colombo Municipal Council') AS location,
         p.image_url AS "imageUrl",
         TO_CHAR(bd.booking_date, 'DD Mon YYYY') AS date,
         TO_CHAR(bd.booking_date, 'YYYY-MM-DD') AS "dateIso",
         bd.booking_date AS "rawDate",
         CASE
           WHEN bd.start_time IS NOT NULL AND bd.end_time IS NOT NULL THEN
             CONCAT(TO_CHAR(bd.start_time, 'HH12:MI AM'), ' – ', TO_CHAR(bd.end_time, 'HH12:MI AM'))
           WHEN bd.start_time IS NOT NULL THEN
             TO_CHAR(bd.start_time, 'HH12:MI AM')
           ELSE
             'Full Day'
         END AS time,
         TO_CHAR(bd.start_time, 'HH12:MI AM') AS "startTime",
         TO_CHAR(bd.end_time, 'HH12:MI AM') AS "endTime",
         TO_CHAR(bd.start_time, 'HH24:MI') AS "rawStartTime",
         TO_CHAR(bd.end_time, 'HH24:MI') AS "rawEndTime",
         bd.participants,
         bd.purpose,
         COALESCE(bd.status, 'PENDING') AS status,
         bd.created_at AS "createdAt",
         COALESCE(u.display_name, 'Citizen User') AS "citizenName",
         COALESCE(u.email, 'citizen@lgs.gov.lk') AS "citizenEmail",
         u.public_id AS "citizenPublicId"
       FROM booking_details bd
       LEFT JOIN service_requests sr ON sr.id = bd.request_id AND sr.deleted_at IS NULL
       JOIN buildings b ON b.id = bd.facility_building_id
       LEFT JOIN public_facility_profiles p ON p.building_id = b.id
       LEFT JOIN users u ON u.id = COALESCE(bd.user_id, sr.created_by_user_id)
       ${whereClause}
       ORDER BY bd.booking_date ASC, bd.start_time ASC`,
      params,
    )

    return ok(res, rows)
  }),
)

/* =========================================================
   2. FACILITY AVAILABILITY
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
         COALESCE(bd.booking_code, sr.request_code, CONCAT('BK-', LPAD(bd.id::text, 4, '0'))) AS "bookingCode",
         TO_CHAR(bd.start_time, 'HH24:MI') AS "startTime",
         TO_CHAR(bd.end_time, 'HH24:MI') AS "endTime",
         TO_CHAR(bd.start_time, 'HH12:MI AM') AS "startTimeFormatted",
         TO_CHAR(bd.end_time, 'HH12:MI AM') AS "endTimeFormatted",
         CONCAT(TO_CHAR(bd.start_time, 'HH12:MI AM'), ' – ', TO_CHAR(bd.end_time, 'HH12:MI AM')) AS "timeFormatted",
         COALESCE(bd.status, 'CONFIRMED') AS status,
         bd.purpose
       FROM booking_details bd
       LEFT JOIN service_requests sr ON sr.id = bd.request_id AND sr.deleted_at IS NULL
       WHERE bd.facility_building_id = ?
         AND bd.booking_date = ?::DATE
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
   3. LIST BOOKABLE FACILITIES / VENUES
   GET /api/v1/bookings/facilities
   - Citizens see active, bookable venues.
   - Privileged roles (GOV_ADMIN, APPROVER, SUPERIOR) can also request includeInactive=true.
========================================================= */
router.get(
  '/facilities',
  asyncHandler(async (req, res) => {
    const isPrivileged = PRIVILEGED_FACILITY_ROLES.includes(req.authUser?.role || '')
    const includeInactive = isPrivileged && req.query.includeInactive === 'true'

    const whereClauses = [
      'b.public_facility IS TRUE',
      'b.deleted_at IS NULL',
    ]

    if (!includeInactive) {
      whereClauses.push('b.active IS TRUE')
      whereClauses.push('p.active IS TRUE')
      whereClauses.push('p.bookable IS TRUE')
    }

    const [rows] = await pool.execute<RowDataPacket[]>(
      `SELECT
         b.id,
         b.building_code AS code,
         COALESCE(b.resolved_name, b.name) AS name,
         COALESCE(b.address, 'Colombo Municipal Council') AS address,
         p.capacity,
         TO_CHAR(p.opening_time, 'HH12:MI AM') AS "openingTime",
         TO_CHAR(p.closing_time, 'HH12:MI AM') AS "closingTime",
         TO_CHAR(p.opening_time, 'HH24:MI') AS "rawOpeningTime",
         TO_CHAR(p.closing_time, 'HH24:MI') AS "rawClosingTime",
         p.description,
         p.image_url AS "imageUrl",
         (p.bookable IS TRUE AND p.active IS TRUE AND b.active IS TRUE) AS "isAvailable",
         b.active AS "buildingActive",
         p.active AS "profileActive",
         p.bookable AS "bookable"
       FROM buildings b
       JOIN public_facility_profiles p ON p.building_id = b.id
       WHERE ${whereClauses.join(' AND ')}
       ORDER BY b.id ASC`,
    )

    return ok(res, rows)
  }),
)

/* =========================================================
   4. GOVERNMENT VENUE MANAGEMENT: ADD NEW FACILITY
   POST /api/v1/bookings/facilities
   Allowed for: GOV_ADMIN, APPROVER, SUPERIOR
   Supports multipart/form-data for image file upload.
========================================================= */
const createFacilitySchema = z.object({
  name: z.string().trim().min(3).max(255),
  code: z.string().trim().max(50).optional(),
  address: z.string().trim().max(500).optional(),
  capacity: z.coerce.number().int().positive().max(100000).default(100),
  openingTime: z.string().trim().default('08:00'),
  closingTime: z.string().trim().default('20:00'),
  description: z.string().trim().max(2000).optional(),
  imageUrl: z.string().trim().optional(),
})

router.post(
  '/facilities',
  upload.single('image'),
  asyncHandler(async (req, res) => {
    if (!PRIVILEGED_FACILITY_ROLES.includes(req.authUser!.role)) {
      throw forbidden('Only municipal administrators, approvers, and directors can add facilities.')
    }

    const input = createFacilitySchema.parse(req.body)

    let finalImageUrl = input.imageUrl || '/facilities/community-hall.jpg'

    // If an image file was uploaded, save it securely into the backend uploads folder
    if (req.file) {
      const mime = req.file.mimetype.toLowerCase()
      let ext = 'jpg'
      if (mime.includes('png')) ext = 'png'
      else if (mime.includes('webp')) ext = 'webp'
      else if (mime.includes('jpeg') || mime.includes('jpg')) ext = 'jpg'
      else {
        throw badRequest('Only PNG, JPG, or WEBP images are supported.')
      }

      const facilitiesDir = path.resolve(env.UPLOAD_DIR, 'facilities')
      await fs.mkdir(facilitiesDir, { recursive: true })

      const safeBase = input.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'venue'
      const filename = `${safeBase}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}.${ext}`
      const targetPath = path.join(facilitiesDir, filename)

      await fs.writeFile(targetPath, req.file.buffer)
      finalImageUrl = `/uploads/facilities/${filename}`
    }

    // Determine building code
    let buildingCode = input.code ? input.code.toUpperCase() : ''
    if (!buildingCode) {
      const [maxRes] = await pool.execute<RowDataPacket[]>(
        "SELECT MAX(id) AS max_id FROM buildings WHERE building_code LIKE 'LGS-FAC-%'",
      )
      const nextId = (Number(maxRes[0]?.max_id) || 0) + 1
      buildingCode = `LGS-FAC-${String(nextId).padStart(6, '0')}`
    }

    const sOpen = input.openingTime.includes(':') && input.openingTime.length === 5 ? `${input.openingTime}:00` : input.openingTime
    const sClose = input.closingTime.includes(':') && input.closingTime.length === 5 ? `${input.closingTime}:00` : input.closingTime

    // Atomic transaction for inserting building and profile
    const createdFacility = await withTransaction(async (connection) => {
      // 1. Insert into buildings table
      const [bldResult] = await connection.execute<ResultSetHeader>(
        `INSERT INTO buildings
          (building_code, name, resolved_name, address, building_type, public_facility, active, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'PUBLIC_FACILITY', TRUE, TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
         RETURNING id`,
        [
          buildingCode,
          input.name,
          input.name,
          input.address || 'Colombo Municipal Council',
        ],
      )

      const buildingId = bldResult.insertId

      // 2. Insert into public_facility_profiles
      await connection.execute(
        `INSERT INTO public_facility_profiles
          (building_id, bookable, capacity, opening_time, closing_time, booking_requires_approval, advance_booking_days, minimum_notice_hours, description, image_url, active, created_at, updated_at)
         VALUES (?, TRUE, ?, ?::TIME, ?::TIME, FALSE, 30, 24, ?, ?, TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [
          buildingId,
          input.capacity,
          sOpen,
          sClose,
          input.description || 'Public Municipal Venue',
          finalImageUrl,
        ],
      )

      return {
        id: buildingId,
        code: buildingCode,
        name: input.name,
        address: input.address || 'Colombo Municipal Council',
        capacity: input.capacity,
        openingTime: sOpen,
        closingTime: sClose,
        description: input.description,
        imageUrl: finalImageUrl,
        isAvailable: true,
      }
    })

    await writeAudit({
      actorUserId: req.authUser!.id,
      action: 'FACILITY_CREATED',
      entityType: 'FACILITY',
      entityId: buildingCode,
      afterData: createdFacility,
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
      requestId: req.requestId,
    })

    return created(res, {
      success: true,
      facility: createdFacility,
      message: 'Venue created and published to booking list successfully.',
    })
  }),
)

/* =========================================================
   5. GOVERNMENT VENUE MANAGEMENT: REMOVE / DEACTIVATE FACILITY
   DELETE /api/v1/bookings/facilities/:id
   Allowed for: GOV_ADMIN, APPROVER, SUPERIOR
========================================================= */
router.delete(
  '/facilities/:id',
  asyncHandler(async (req, res) => {
    if (!PRIVILEGED_FACILITY_ROLES.includes(req.authUser!.role)) {
      throw forbidden('Only municipal administrators, approvers, and directors can remove facilities.')
    }

    const rawId = routeParam(req.params.id, 'id')

    // Find building
    const [bldRows] = await pool.execute<RowDataPacket[]>(
      'SELECT id, building_code, name FROM buildings WHERE (id = ? OR building_code = ?) AND deleted_at IS NULL LIMIT 1',
      [rawId, rawId],
    )

    const building = bldRows[0]
    if (!building) {
      throw notFound('Venue / facility not found.')
    }

    // Soft deactivate from bookable list
    await pool.execute(
      `UPDATE public_facility_profiles 
          SET bookable = FALSE, active = FALSE, updated_at = CURRENT_TIMESTAMP 
        WHERE building_id = ?`,
      [building.id],
    )

    await pool.execute(
      `UPDATE buildings 
          SET active = FALSE, updated_at = CURRENT_TIMESTAMP 
        WHERE id = ?`,
      [building.id],
    )

    await writeAudit({
      actorUserId: req.authUser!.id,
      action: 'FACILITY_DEACTIVATED',
      entityType: 'FACILITY',
      entityId: building.building_code,
      afterData: { buildingId: building.id, status: 'REMOVED_FROM_BOOKING' },
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
      requestId: req.requestId,
    })

    return ok(res, {
      success: true,
      removed: true,
      message: `"${building.name}" has been removed from the booking list.`,
    })
  }),
)

/* =========================================================
   6. GOVERNMENT VENUE MANAGEMENT: TOGGLE ACTIVE STATUS
   PATCH /api/v1/bookings/facilities/:id/toggle
   Allowed for: GOV_ADMIN, APPROVER, SUPERIOR
========================================================= */
router.patch(
  '/facilities/:id/toggle',
  asyncHandler(async (req, res) => {
    if (!PRIVILEGED_FACILITY_ROLES.includes(req.authUser!.role)) {
      throw forbidden('Only municipal administrators, approvers, and directors can modify venues.')
    }

    const rawId = routeParam(req.params.id, 'id')

    const [bldRows] = await pool.execute<RowDataPacket[]>(
      `SELECT b.id, b.building_code, b.name, p.bookable, p.active 
         FROM buildings b
         JOIN public_facility_profiles p ON p.building_id = b.id
        WHERE (b.id = ? OR b.building_code = ?) LIMIT 1`,
      [rawId, rawId],
    )

    const building = bldRows[0]
    if (!building) {
      throw notFound('Venue / facility not found.')
    }

    const newActiveState = !building.active

    await pool.execute(
      `UPDATE public_facility_profiles 
          SET bookable = ?, active = ?, updated_at = CURRENT_TIMESTAMP 
        WHERE building_id = ?`,
      [newActiveState, newActiveState, building.id],
    )

    await pool.execute(
      `UPDATE buildings 
          SET active = ?, updated_at = CURRENT_TIMESTAMP 
        WHERE id = ?`,
      [newActiveState, building.id],
    )

    await writeAudit({
      actorUserId: req.authUser!.id,
      action: 'FACILITY_STATUS_TOGGLED',
      entityType: 'FACILITY',
      entityId: building.building_code,
      afterData: { buildingId: building.id, active: newActiveState },
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
      requestId: req.requestId,
    })

    return ok(res, {
      success: true,
      active: newActiveState,
      message: `Venue ${newActiveState ? 'activated' : 'deactivated'} successfully.`,
    })
  }),
)

/* =========================================================
   7. CREATE A BOOKING (WITH TRANSACTION, ISOLATION & COLLISION PREVENTION)
   POST /api/v1/bookings
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
         WHERE b.public_facility IS TRUE AND p.bookable IS TRUE AND b.active IS TRUE AND p.active IS TRUE LIMIT 1`,
      )
      facilityId = defRows[0]?.id
    }

    if (!facilityId) {
      throw badRequest('Please select a valid municipal facility.')
    }

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
       ATOMIC TRANSACTION WITH ROW LOCKING & SERIALIZED ISOLATION
       Guarantees collision prevention under concurrent booking attempts.
    ========================================================= */
    const { bookingCode, facility } = await withTransaction(async (connection) => {
      // 1. Lock the facility row to serialize concurrent booking attempts for this venue
      const [facRows] = await connection.execute<RowDataPacket[]>(
        `SELECT b.id, COALESCE(b.resolved_name, b.name) AS name, p.capacity, p.bookable, p.active
           FROM buildings b
           JOIN public_facility_profiles p ON p.building_id = b.id
          WHERE b.id = ? AND b.deleted_at IS NULL LIMIT 1 FOR UPDATE OF b, p`,
        [facilityId],
      )

      const facilityRow = facRows[0]
      if (!facilityRow) {
        throw notFound('Selected facility not found.')
      }

      if (facilityRow.bookable === false || facilityRow.active === false) {
        throw badRequest('This facility is currently not available for bookings.')
      }

      // 2. Collision check inside transaction with row lock
      const [collisions] = await connection.execute<RowDataPacket[]>(
        `SELECT bd.id,
                COALESCE(bd.booking_code, CONCAT('BK-', LPAD(bd.id::text, 4, '0'))) AS "bookingCode",
                COALESCE(b.resolved_name, b.name) AS "facilityName",
                TO_CHAR(bd.start_time, 'HH12:MI AM') AS "startFormatted",
                TO_CHAR(bd.end_time, 'HH12:MI AM') AS "endFormatted"
           FROM booking_details bd
           JOIN buildings b ON b.id = bd.facility_building_id
          WHERE bd.facility_building_id = ?
            AND bd.booking_date = ?::DATE
            AND bd.status NOT IN ('CANCELLED', 'REJECTED')
            AND (bd.start_time IS NULL OR bd.end_time IS NULL OR (bd.start_time < ?::TIME AND bd.end_time > ?::TIME))
          FOR UPDATE OF bd`,
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
         VALUES (NULL, ?, ?, ?::DATE, ?::TIME, ?::TIME, ?, ?, 'CONFIRMED', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
         RETURNING id`,
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
      let code = `BK-${year}-${String(insertId).padStart(4, '0')}`

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
          if ((err?.code === 'ER_DUP_ENTRY' || err?.code === '23505') && attempts < 4) {
            attempts++
            code = `BK-${year}-${String(insertId + attempts).padStart(4, '0')}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`
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
   8. ADMIN/OFFICER: UPDATE BOOKING STATUS
   PATCH /api/v1/bookings/:id/status
   Allowed for: GOV_ADMIN, APPROVER, SUPERIOR
========================================================= */
router.patch(
  '/:id/status',
  asyncHandler(async (req, res) => {
    if (!PRIVILEGED_FACILITY_ROLES.includes(req.authUser!.role)) {
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
              COALESCE(b.resolved_name, b.name) AS "facilityName"
         FROM booking_details bd
         JOIN buildings b ON b.id = bd.facility_building_id
        WHERE (bd.booking_code = ? OR bd.id::text = ?) LIMIT 1`,
      [rawId, rawId],
    )

    const booking = rows[0]
    if (!booking) {
      throw notFound('Booking not found.')
    }

    await pool.execute(
      'UPDATE booking_details SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
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
   9. CANCEL A BOOKING
   POST /api/v1/bookings/:id/cancel
========================================================= */
router.post(
  '/:id/cancel',
  asyncHandler(async (req, res) => {
    const rawId = routeParam(req.params.id, 'id')

    const [rows] = await pool.execute<RowDataPacket[]>(
      `SELECT bd.id, bd.booking_code, bd.user_id, bd.status 
         FROM booking_details bd 
        WHERE (bd.booking_code = ? OR bd.id::text = ?) LIMIT 1`,
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
      "UPDATE booking_details SET status = 'CANCELLED', updated_at = CURRENT_TIMESTAMP WHERE id = ?",
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
