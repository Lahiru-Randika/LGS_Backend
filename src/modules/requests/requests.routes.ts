import crypto from 'node:crypto'
import path from 'node:path'
import fs from 'node:fs/promises'
import { Router } from 'express'
import type {
  PoolConnection,
  ResultSetHeader,
  RowDataPacket,
} from 'mysql2/promise'
import { z } from 'zod'
import { pool, withTransaction } from '../../config/db'
import { env } from '../../config/env'
import { authenticate } from '../../middleware/authenticate'
import { requirePermission } from '../../middleware/authorize'
import { persistUploads, removePersistedUploads, upload } from '../../middleware/upload'
import { writeAudit } from '../../services/audit.service'
import {
  notifyRequestAssignment,
  notifyRequestCreated,
  notifyRequestStatusChanged,
} from '../../services/notification.service'
import { asyncHandler } from '../../utils/asyncHandler'
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../../utils/errors'
import { created, ok } from '../../utils/http'

const router = Router()
router.use(authenticate)

const requestTypes = ['COMPLAINT', 'SUGGESTION', 'INQUIRY', 'BOOKING'] as const
const priorities = ['LOW', 'NORMAL', 'HIGH', 'URGENT'] as const
const contactPreferences = ['PORTAL', 'EMAIL'] as const

const createRequestSchema = z.object({
  clientRequestId: z.string().uuid(),
  type: z.enum(requestTypes),
  title: z.string().trim().min(5).max(255),
  description: z.string().trim().min(10).max(5000),
  priority: z.enum(priorities).default('NORMAL'),
  contactPreference: z.enum(contactPreferences).default('PORTAL'),
  location: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('BUILDING'), buildingCode: z.string().trim().min(1).max(50) }),
    z.object({
      kind: z.literal('POINT'),
      latitude: z.number().min(-90).max(90),
      longitude: z.number().min(-180).max(180),
      label: z.string().trim().min(1).max(255),
    }),
    z.object({
      kind: z.literal('ROAD'),
      latitude: z.number().min(-90).max(90),
      longitude: z.number().min(-180).max(180),
      label: z.string().trim().min(1).max(255),
    }),
    z.object({
      kind: z.literal('OTHER'),
      latitude: z.number().min(-90).max(90),
      longitude: z.number().min(-180).max(180),
      label: z.string().trim().min(1).max(255),
    }),
  ]),
  booking: z.object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    startTime: z.string().regex(/^\d{2}:\d{2}$/).nullable().optional(),
    endTime: z.string().regex(/^\d{2}:\d{2}$/).nullable().optional(),
    participants: z.number().int().positive().max(100000),
    purpose: z.string().trim().max(500).nullable().optional(),
  }).optional(),
})

const updateRequestSchema = z.object({
  title: z.string().trim().min(5).max(255).optional(),
  description: z.string().trim().min(10).max(5000).optional(),
  priority: z.enum(priorities).optional(),
  contactPreference: z.enum(contactPreferences).optional(),
  version: z.number().int().positive(),
}).refine((v) => v.title || v.description || v.priority || v.contactPreference, { message: 'At least one field must be supplied.' })

const assignmentSchema = z.object({
  assignedToUserId: z.string().uuid(),
  departmentId: z.number().int().positive().nullable().optional(),
  note: z.string().trim().max(2000).optional(),
  version: z.number().int().positive(),
})

const transitionSchema = z.object({
  toStatus: z.enum([
    'UNDER_REVIEW','ASSIGNED','INSPECTION_SCHEDULED','INSPECTING','ACTION_REQUIRED','IN_PROGRESS',
    'NEEDS_APPROVAL','AWAITING_APPROVAL','RESOLVED','CLOSED','REJECTED','CANCELLED','DUPLICATE',
  ]),
  note: z.string().trim().max(3000).optional(),
  version: z.number().int().positive(),
})

const noteSchema = z.object({
  body: z.string().trim().min(1).max(5000),
  visibility: z.enum(['PUBLIC', 'CITIZEN_VISIBLE', 'INTERNAL']).default('INTERNAL'),
})

interface RequestRow extends RowDataPacket {
  id: number
  request_code: string
  client_request_id: string
  type: string
  title: string
  description: string
  status: string
  priority: string
  department_id: number | null
  ward_id: number | null
  building_id: number | null
  location_type: string
  location_label: string | null
  latitude: string | null
  longitude: string | null
  created_by_user_id: number
  assigned_to_user_id: number | null
  contact_preference: string
  version: number
  created_at: Date
  updated_at: Date
}

function requestScope(user: Express.AuthUser) {
  if (user.permissions.includes('request.all.read')) return { clause: '1=1', params: [] as any[] }
  if (user.permissions.includes('request.assigned.read')) return { clause: 'sr.assigned_to_user_id = ?', params: [user.id] as any[] }
  if (user.permissions.includes('request.own.read')) return { clause: 'sr.created_by_user_id = ?', params: [user.id] as any[] }
  return { clause: '1=0', params: [] as any[] }
}

function routeParam(
  value: string | string[] | undefined,
  name: string,
): string {
  const resolved =
    Array.isArray(value)
      ? value[0]
      : value

  if (!resolved) {
    throw badRequest(
      `Missing route parameter: ${name}.`,
    )
  }

  return resolved
}

async function getVisibleRequest(code: string, user: Express.AuthUser) {
  const scope = requestScope(user)
  const [rows] = await pool.execute<RequestRow[]>(
    `SELECT sr.* FROM service_requests sr
      WHERE sr.request_code = ? AND sr.deleted_at IS NULL AND ${scope.clause}
      LIMIT 1`,
    [code, ...scope.params],
  )
  return rows[0]
}

async function nextRequestCode(connection: PoolConnection) {
  const year = new Date().getUTCFullYear()
  await connection.execute('INSERT IGNORE INTO request_sequences (year, last_number) VALUES (?, 0)', [year])
  const [rows] = await connection.execute<(RowDataPacket & { last_number: number })[]>('SELECT last_number FROM request_sequences WHERE year = ? FOR UPDATE', [year])
  const next = Number(rows[0]?.last_number ?? 0) + 1
  await connection.execute('UPDATE request_sequences SET last_number = ? WHERE year = ?', [next, year])
  return `LGS-${year}-${String(next).padStart(6, '0')}`
}

function parseRequestPayload(req: any) {
  if (typeof req.body?.payload === 'string') {
    try { return JSON.parse(req.body.payload) } catch { throw badRequest('payload must contain valid JSON.') }
  }
  return req.body
}

const allowedTransitions: Record<string, string[]> = {
  CREATED: ['UNDER_REVIEW', 'CANCELLED'],
  UNDER_REVIEW: ['ASSIGNED', 'REJECTED', 'DUPLICATE', 'CANCELLED'],
  ASSIGNED: ['INSPECTION_SCHEDULED', 'INSPECTING', 'IN_PROGRESS'],
  INSPECTION_SCHEDULED: ['INSPECTING', 'IN_PROGRESS'],
  INSPECTING: ['ACTION_REQUIRED', 'IN_PROGRESS', 'RESOLVED'],
  ACTION_REQUIRED: ['IN_PROGRESS', 'NEEDS_APPROVAL', 'RESOLVED'],
  IN_PROGRESS: ['NEEDS_APPROVAL', 'RESOLVED'],
  NEEDS_APPROVAL: ['AWAITING_APPROVAL', 'IN_PROGRESS'],
  AWAITING_APPROVAL: ['IN_PROGRESS', 'REJECTED', 'RESOLVED'],
  RESOLVED: ['CLOSED', 'IN_PROGRESS'],
  CLOSED: [],
  REJECTED: [],
  CANCELLED: [],
  DUPLICATE: [],
}

router.post('/', requirePermission('request.create'), upload.array('files', env.MAX_UPLOAD_FILES), asyncHandler(async (req, res) => {
  const input = createRequestSchema.parse(parseRequestPayload(req))
  if (input.type === 'BOOKING' && (!input.booking || input.location.kind !== 'BUILDING')) {
    throw badRequest('Booking requests require booking details and a building location.')
  }
  if (input.type !== 'BOOKING' && input.booking) throw badRequest('booking is only valid for BOOKING requests.')

  const [existing] = await pool.execute<(RowDataPacket & { request_code: string })[]>(
    'SELECT request_code FROM service_requests WHERE created_by_user_id = ? AND client_request_id = ? LIMIT 1',
    [req.authUser!.id, input.clientRequestId],
  )
  if (existing[0]) return ok(res, { requestCode: existing[0].request_code, duplicateSubmission: true })

  const files = await persistUploads((req.files as Express.Multer.File[] | undefined) ?? [])
  try {
    const data = await withTransaction(async (connection) => {
      let buildingId: number | null = null
      let wardId: number | null = null
      let latitude: number | null = null
      let longitude: number | null = null
      let locationLabel: string | null = null

      if (input.location.kind === 'BUILDING') {
        const [buildings] = await connection.execute<(RowDataPacket & {
          id: number; ward_id: number | null; latitude: string | null; longitude: string | null; name: string | null; resolved_name: string | null; address: string | null; public_facility: number;
        })[]>(
          `SELECT id, ward_id, latitude, longitude, name, resolved_name, address, public_facility
             FROM buildings WHERE building_code = ? AND active = 1 AND deleted_at IS NULL LIMIT 1`,
          [input.location.buildingCode],
        )
        const building = buildings[0]
        if (!building) throw badRequest('Selected building was not found.')
        buildingId = building.id
        wardId = building.ward_id
        latitude = building.latitude == null ? null : Number(building.latitude)
        longitude = building.longitude == null ? null : Number(building.longitude)
        locationLabel = building.resolved_name || building.name || building.address || input.location.buildingCode
        if (input.type === 'BOOKING' && building.public_facility !== 1) throw unprocessable('Selected building is not a public facility.')
      } else {
        latitude = input.location.latitude
        longitude = input.location.longitude
        locationLabel = input.location.label
      }

      const requestCode = await nextRequestCode(connection)
      const [result] = await connection.execute<ResultSetHeader>(
        `INSERT INTO service_requests
          (request_code, client_request_id, type, title, description, status, priority, ward_id, building_id,
           location_type, location_label, latitude, longitude, created_by_user_id, contact_preference, version, created_at)
         VALUES (?, ?, ?, ?, ?, 'CREATED', ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, UTC_TIMESTAMP())`,
        [requestCode, input.clientRequestId, input.type, input.title, input.description, input.priority, wardId, buildingId,
         input.location.kind, locationLabel, latitude, longitude, req.authUser!.id, input.contactPreference],
      )
      const requestId = result.insertId

      await connection.execute(
        `INSERT INTO request_status_history (request_id, from_status, to_status, label, note, changed_by_user_id, created_at)
         VALUES (?, NULL, 'CREATED', 'Submitted', NULL, ?, UTC_TIMESTAMP())`,
        [requestId, req.authUser!.id],
      )

      if (input.type === 'BOOKING' && input.booking && buildingId) {
        const [profiles] = await connection.execute<(RowDataPacket & { bookable: number; capacity: number | null })[]>(
          'SELECT bookable, capacity FROM public_facility_profiles WHERE building_id = ? AND active = 1 LIMIT 1',
          [buildingId],
        )
        if (profiles[0] && profiles[0].bookable !== 1) throw unprocessable('This public facility is not currently bookable.')
        if (profiles[0]?.capacity && input.booking.participants > profiles[0].capacity) throw unprocessable('Participant count exceeds facility capacity.')
        await connection.execute(
          `INSERT INTO booking_details
            (request_id, facility_building_id, booking_date, start_time, end_time, participants, purpose, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING', UTC_TIMESTAMP())`,
          [requestId, buildingId, input.booking.date, input.booking.startTime ?? null, input.booking.endTime ?? null, input.booking.participants, input.booking.purpose ?? null],
        )
      }

      for (const file of files) {
        await connection.execute(
          `INSERT INTO request_attachments
            (public_id, request_id, uploaded_by_user_id, category, storage_provider, storage_key, original_filename, mime_type, file_size, sha256, visibility, created_at)
           VALUES (?, ?, ?, 'INITIAL_EVIDENCE', 'LOCAL', ?, ?, ?, ?, ?, 'CITIZEN_VISIBLE', UTC_TIMESTAMP())`,
          [crypto.randomUUID(), requestId, req.authUser!.id, file.storageKey, file.originalFilename, file.mimeType, file.fileSize, file.sha256],
        )
      }

      await notifyRequestCreated(
        {
          userId: req.authUser!.id,
          requestCode,
        },
        connection,
      )

      await writeAudit({ actorUserId: req.authUser!.id, action: 'REQUEST_CREATED', entityType: 'SERVICE_REQUEST', entityId: requestCode, afterData: { type: input.type, priority: input.priority, locationType: input.location.kind }, ipAddress: req.ip, userAgent: req.get('user-agent'), requestId: req.requestId }, connection)
      return { requestCode, status: 'CREATED', version: 1 }
    })
    return created(res, data)
  } catch (error) {
    await removePersistedUploads(files)
    throw error
  }
}))

router.get('/', asyncHandler(async (req, res) => {
  const q = z.object({
    search: z.string().trim().max(200).optional(),
    status: z.string().trim().max(40).optional(),
    type: z.enum(requestTypes).optional(),
    priority: z.enum(priorities).optional(),
    departmentId: z.coerce.number().int().positive().optional(),
    wardId: z.coerce.number().int().positive().optional(),
    assignedTo: z.string().uuid().optional(),
    buildingCode: z.string().trim().max(50).optional(),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(25),
  }).parse(req.query)

  const scope = requestScope(req.authUser!)
  const where = ['sr.deleted_at IS NULL', scope.clause]
  const params: any[] = [...scope.params]
  if (q.search) { where.push('(sr.request_code LIKE ? OR sr.title LIKE ? OR sr.location_label LIKE ?)'); params.push(`%${q.search}%`, `%${q.search}%`, `%${q.search}%`) }
  if (q.status) { where.push('sr.status = ?'); params.push(q.status) }
  if (q.type) { where.push('sr.type = ?'); params.push(q.type) }
  if (q.priority) { where.push('sr.priority = ?'); params.push(q.priority) }
  if (q.departmentId) { where.push('sr.department_id = ?'); params.push(q.departmentId) }
  if (q.wardId) { where.push('sr.ward_id = ?'); params.push(q.wardId) }
  if (q.assignedTo) { where.push('assignee.public_id = ?'); params.push(q.assignedTo) }
  if (q.buildingCode) { where.push('b.building_code = ?'); params.push(q.buildingCode) }

  const offset = (q.page - 1) * q.limit
  const join = `LEFT JOIN users assignee ON assignee.id = sr.assigned_to_user_id
                LEFT JOIN departments d ON d.id = sr.department_id
                LEFT JOIN wards w ON w.id = sr.ward_id
                LEFT JOIN buildings b ON b.id = sr.building_id`
  const [rows] = await pool.execute<RowDataPacket[]>(
    `SELECT sr.request_code AS requestCode, sr.type, sr.title, sr.status, sr.priority,
            sr.location_label AS locationLabel, sr.latitude, sr.longitude, sr.version,
            sr.created_at AS createdAt, sr.updated_at AS updatedAt,
            d.name AS departmentName, w.name AS wardName,
            b.building_code AS buildingCode, COALESCE(b.resolved_name, b.name) AS buildingName,
            assignee.public_id AS assignedToId, assignee.display_name AS assignedToName
       FROM service_requests sr ${join}
      WHERE ${where.join(' AND ')}
      ORDER BY sr.created_at DESC LIMIT ? OFFSET ?`,
    [...params, q.limit, offset],
  )
  const [counts] = await pool.execute<(RowDataPacket & { total: number })[]>(
    `SELECT COUNT(*) AS total FROM service_requests sr ${join} WHERE ${where.join(' AND ')}`,
    params,
  )
  return ok(res, rows, { page: q.page, limit: q.limit, total: counts[0]?.total ?? 0 })
}))

router.get('/:code', asyncHandler(async (req, res) => {
  const request = await getVisibleRequest(    routeParam(
      req.params.code,
      'code',
    ),
    req.authUser!,)
  if (!request) throw notFound('Request not found.')

  const [details] = await pool.execute<RowDataPacket[]>(
    `SELECT sr.request_code AS requestCode, sr.type, sr.title, sr.description, sr.status, sr.priority,
            sr.location_type AS locationType, sr.location_label AS locationLabel, sr.latitude, sr.longitude,
            sr.contact_preference AS contactPreference, sr.version, sr.created_at AS createdAt, sr.updated_at AS updatedAt,
            d.id AS departmentId, d.name AS departmentName, w.id AS wardId, w.name AS wardName,
            b.building_code AS buildingCode, COALESCE(b.resolved_name, b.name) AS buildingName, b.address AS buildingAddress,
            creator.public_id AS createdById, creator.display_name AS createdByName,
            assignee.public_id AS assignedToId, assignee.display_name AS assignedToName
       FROM service_requests sr
       LEFT JOIN departments d ON d.id = sr.department_id
       LEFT JOIN wards w ON w.id = sr.ward_id
       LEFT JOIN buildings b ON b.id = sr.building_id
       JOIN users creator ON creator.id = sr.created_by_user_id
       LEFT JOIN users assignee ON assignee.id = sr.assigned_to_user_id
      WHERE sr.id = ? LIMIT 1`, [request.id])

  const [history] = await pool.execute<RowDataPacket[]>(
    `SELECT h.from_status AS fromStatus, h.to_status AS toStatus, h.label, h.note,
            u.display_name AS changedBy, h.created_at AS createdAt
       FROM request_status_history h JOIN users u ON u.id = h.changed_by_user_id
      WHERE h.request_id = ? ORDER BY h.created_at`, [request.id])

  const visibilityClause = req.authUser!.role === 'CITIZEN' ? "AND n.visibility IN ('PUBLIC','CITIZEN_VISIBLE')" : ''
  const [notes] = await pool.execute<RowDataPacket[]>(
    `SELECT n.id, n.body, n.visibility, u.display_name AS author, n.created_at AS createdAt
       FROM request_notes n JOIN users u ON u.id = n.author_user_id
      WHERE n.request_id = ? ${visibilityClause} ORDER BY n.created_at`, [request.id])

  const attachmentVisibility = req.authUser!.role === 'CITIZEN' ? "AND a.visibility = 'CITIZEN_VISIBLE'" : ''
  const [attachments] = await pool.execute<RowDataPacket[]>(
    `SELECT a.public_id AS id, a.category, a.original_filename AS filename, a.mime_type AS mimeType,
            a.file_size AS fileSize, a.visibility, a.created_at AS createdAt
       FROM request_attachments a WHERE a.request_id = ? AND a.deleted_at IS NULL ${attachmentVisibility}
      ORDER BY a.created_at`, [request.id])

  const [inspection] = await pool.execute<RowDataPacket[]>(
    `SELECT i.public_id AS id, i.status, i.scheduled_for AS scheduledFor, i.started_at AS startedAt,
            i.completed_at AS completedAt, i.summary, u.display_name AS officerName
       FROM inspections i JOIN users u ON u.id = i.officer_user_id
      WHERE i.request_id = ? ORDER BY i.created_at DESC LIMIT 1`, [request.id])

  const [approval] = await pool.execute<RowDataPacket[]>(
    `SELECT a.public_id AS id, a.approval_type AS approvalType, a.requested_action AS requestedAction,
            a.justification, a.status, a.due_at AS dueAt, a.created_at AS createdAt, a.decided_at AS decidedAt
       FROM approval_requests a WHERE a.request_id = ? ORDER BY a.created_at DESC LIMIT 1`, [request.id])

  const [booking] = await pool.execute<RowDataPacket[]>(
    `SELECT booking_date AS date, start_time AS startTime, end_time AS endTime, participants, purpose, status
       FROM booking_details WHERE request_id = ? LIMIT 1`, [request.id])

  return ok(res, { ...details[0], history, notes, attachments, inspection: inspection[0] ?? null, approval: approval[0] ?? null, booking: booking[0] ?? null })
}))

router.patch('/:code', asyncHandler(async (req, res) => {
  const input = updateRequestSchema.parse(req.body)
  const current = await getVisibleRequest(    routeParam(
      req.params.code,
      'code',
    ),
    req.authUser!,)
  if (!current) throw notFound('Request not found.')

  const isOwner = current.created_by_user_id === req.authUser!.id
  const canAdminUpdate = req.authUser!.permissions.includes('request.update') && req.authUser!.role !== 'GOV_WORKER'
  if (isOwner) {
    if (!['CREATED', 'UNDER_REVIEW'].includes(current.status)) throw unprocessable('Citizens can edit a request only while it is new or under review.')
    if (input.priority) throw forbidden('Citizens cannot change server-managed priority after submission.')
  } else if (!canAdminUpdate) throw forbidden()
  if (current.version !== input.version) throw conflict('Request changed since you loaded it. Refresh and try again.')

  const sets: string[] = []
  const params: any[] = []
  if (input.title !== undefined) { sets.push('title = ?'); params.push(input.title) }
  if (input.description !== undefined) { sets.push('description = ?'); params.push(input.description) }
  if (input.priority !== undefined) { sets.push('priority = ?'); params.push(input.priority) }
  if (input.contactPreference !== undefined) { sets.push('contact_preference = ?'); params.push(input.contactPreference) }
  sets.push('version = version + 1', 'updated_at = UTC_TIMESTAMP()')

  const [result] = await pool.execute<ResultSetHeader>(`UPDATE service_requests SET ${sets.join(', ')} WHERE id = ? AND version = ?`, [...params, current.id, input.version])
  if (result.affectedRows !== 1) throw conflict('Request changed since you loaded it. Refresh and try again.')
  await writeAudit({ actorUserId: req.authUser!.id, action: 'REQUEST_UPDATED', entityType: 'SERVICE_REQUEST', entityId: current.request_code, afterData: input, ipAddress: req.ip, userAgent: req.get('user-agent'), requestId: req.requestId })
  return ok(res, { updated: true, version: input.version + 1 })
}))

router.patch('/:code/assignment', requirePermission('request.assign'), asyncHandler(async (req, res) => {
  const input = assignmentSchema.parse(req.body)
  const current = await getVisibleRequest(routeParam(req.params.code, 'code'), req.authUser!)
  if (!current) throw notFound('Request not found.')
  if (current.version !== input.version) throw conflict('Request changed since you loaded it. Refresh and try again.')
  if (['RESOLVED','CLOSED','REJECTED','CANCELLED','DUPLICATE'].includes(current.status)) throw unprocessable('This request can no longer be assigned.')

  const [workers] = await pool.execute<(RowDataPacket & { id: number; display_name: string; department_id: number | null })[]>(
    `SELECT u.id, u.display_name, u.department_id FROM users u JOIN roles r ON r.id = u.role_id
      WHERE u.public_id = ? AND r.code = 'GOV_WORKER' AND u.status = 'ACTIVE' AND u.deleted_at IS NULL LIMIT 1`,
    [input.assignedToUserId],
  )
  const worker = workers[0]
  if (!worker) throw badRequest('Assigned user must be an active GOV_WORKER.')
  const departmentId = input.departmentId ?? worker.department_id ?? current.department_id

  await withTransaction(async (connection) => {
    const [result] = await connection.execute<ResultSetHeader>(
      `UPDATE service_requests SET assigned_to_user_id = ?, department_id = ?, status = 'ASSIGNED', version = version + 1, updated_at = UTC_TIMESTAMP()
        WHERE id = ? AND version = ?`, [worker.id, departmentId, current.id, input.version])
    if (result.affectedRows !== 1) throw conflict('Request changed since you loaded it. Refresh and try again.')
    await connection.execute('UPDATE request_assignments SET ended_at = UTC_TIMESTAMP() WHERE request_id = ? AND ended_at IS NULL', [current.id])
    await connection.execute(
      `INSERT INTO request_assignments
       (request_id, from_user_id, to_user_id, from_department_id, to_department_id, assigned_by_user_id, note, assigned_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP())`,
      [current.id, current.assigned_to_user_id, worker.id, current.department_id, departmentId, req.authUser!.id, input.note ?? null],
    )
    await connection.execute(
      `INSERT INTO request_status_history (request_id, from_status, to_status, label, note, changed_by_user_id, created_at)
       VALUES (?, ?, 'ASSIGNED', 'Assigned', ?, ?, UTC_TIMESTAMP())`,
      [current.id, current.status, input.note ?? null, req.authUser!.id],
    )
    await notifyRequestAssignment(
      {
        requestCode: current.request_code,
        citizenUserId: current.created_by_user_id,
        newOfficerUserId: worker.id,
        previousOfficerUserId: current.assigned_to_user_id,
      },
      connection,
    )
    await writeAudit({ actorUserId: req.authUser!.id, action: 'REQUEST_ASSIGNED', entityType: 'SERVICE_REQUEST', entityId: current.request_code, beforeData: { assignedToUserId: current.assigned_to_user_id, departmentId: current.department_id, status: current.status }, afterData: { assignedToUserId: worker.id, departmentId, status: 'ASSIGNED' }, ipAddress: req.ip, userAgent: req.get('user-agent'), requestId: req.requestId }, connection)
  })
  return ok(res, { assigned: true, version: input.version + 1 })
}))

router.post('/:code/status-transitions', requirePermission('request.update'), asyncHandler(async (req, res) => {
  const input = transitionSchema.parse(req.body)
  const current = await getVisibleRequest(routeParam(req.params.code, 'code'), req.authUser!)
  if (!current) throw notFound('Request not found.')
  if (current.version !== input.version) throw conflict('Request changed since you loaded it. Refresh and try again.')
  if (!(allowedTransitions[current.status] ?? []).includes(input.toStatus)) throw unprocessable(`Transition ${current.status} -> ${input.toStatus} is not allowed.`)
  if (req.authUser!.role === 'GOV_WORKER' && current.assigned_to_user_id !== req.authUser!.id) throw forbidden()
  if (input.toStatus === 'AWAITING_APPROVAL') throw unprocessable('Use POST /requests/:code/approvals so an approval record is created atomically.')

  await withTransaction(async (connection) => {
    const [result] = await connection.execute<ResultSetHeader>(
      `UPDATE service_requests
          SET status = ?, version = version + 1, updated_at = UTC_TIMESTAMP(),
              resolved_at = CASE WHEN ? = 'RESOLVED' THEN UTC_TIMESTAMP() ELSE resolved_at END,
              closed_at = CASE WHEN ? = 'CLOSED' THEN UTC_TIMESTAMP() ELSE closed_at END,
              cancelled_at = CASE WHEN ? = 'CANCELLED' THEN UTC_TIMESTAMP() ELSE cancelled_at END
        WHERE id = ? AND version = ?`,
      [input.toStatus, input.toStatus, input.toStatus, input.toStatus, current.id, input.version],
    )
    if (result.affectedRows !== 1) throw conflict('Request changed since you loaded it. Refresh and try again.')
    await connection.execute(
      `INSERT INTO request_status_history (request_id, from_status, to_status, label, note, changed_by_user_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, UTC_TIMESTAMP())`,
      [current.id, current.status, input.toStatus, input.toStatus.replaceAll('_', ' '), input.note ?? null, req.authUser!.id],
    )
    await notifyRequestStatusChanged(
      {
        userId: current.created_by_user_id,
        requestCode: current.request_code,
        toStatus: input.toStatus,
      },
      connection,
    )
    await writeAudit({ actorUserId: req.authUser!.id, action: 'REQUEST_STATUS_CHANGED', entityType: 'SERVICE_REQUEST', entityId: current.request_code, beforeData: { status: current.status }, afterData: { status: input.toStatus, note: input.note ?? null }, ipAddress: req.ip, userAgent: req.get('user-agent'), requestId: req.requestId }, connection)
  })
  return ok(res, { status: input.toStatus, version: input.version + 1 })
}))

router.post('/:code/cancel', asyncHandler(async (req, res) => {
  const input = z.object({ note: z.string().trim().max(2000).optional(), version: z.number().int().positive() }).parse(req.body)
  const current = await getVisibleRequest(routeParam(req.params.code, 'code'), req.authUser!)
  if (!current) throw notFound('Request not found.')
  if (current.created_by_user_id !== req.authUser!.id) throw forbidden()
  if (!['CREATED','UNDER_REVIEW'].includes(current.status)) throw unprocessable('This request can no longer be cancelled by the citizen.')
  if (current.version !== input.version) throw conflict('Request changed since you loaded it. Refresh and try again.')
  await withTransaction(async (connection) => {
    await connection.execute(`UPDATE service_requests SET status = 'CANCELLED', cancelled_at = UTC_TIMESTAMP(), version = version + 1 WHERE id = ? AND version = ?`, [current.id, input.version])
    await connection.execute(`INSERT INTO request_status_history (request_id, from_status, to_status, label, note, changed_by_user_id, created_at) VALUES (?, ?, 'CANCELLED', 'Cancelled', ?, ?, UTC_TIMESTAMP())`, [current.id, current.status, input.note ?? null, req.authUser!.id])
    await writeAudit({ actorUserId: req.authUser!.id, action: 'REQUEST_CANCELLED', entityType: 'SERVICE_REQUEST', entityId: current.request_code, ipAddress: req.ip, userAgent: req.get('user-agent'), requestId: req.requestId }, connection)
  })
  return ok(res, { cancelled: true, version: input.version + 1 })
}))

router.post('/:code/notes', asyncHandler(async (req, res) => {
  const input = noteSchema.parse(req.body)
  const current = await getVisibleRequest(routeParam(req.params.code, 'code'), req.authUser!)
  if (!current) throw notFound('Request not found.')
  if (req.authUser!.role === 'CITIZEN' && input.visibility === 'INTERNAL') throw forbidden('Citizens cannot create internal notes.')
  const [result] = await pool.execute<ResultSetHeader>(
    `INSERT INTO request_notes (request_id, author_user_id, body, visibility, created_at) VALUES (?, ?, ?, ?, UTC_TIMESTAMP())`,
    [current.id, req.authUser!.id, input.body, req.authUser!.role === 'CITIZEN' ? 'CITIZEN_VISIBLE' : input.visibility],
  )
  await writeAudit({ actorUserId: req.authUser!.id, action: 'REQUEST_NOTE_ADDED', entityType: 'REQUEST_NOTE', entityId: result.insertId, afterData: { requestCode: current.request_code, visibility: input.visibility }, ipAddress: req.ip, userAgent: req.get('user-agent'), requestId: req.requestId })
  return created(res, { id: result.insertId })
}))

router.post('/:code/attachments', upload.array('files', env.MAX_UPLOAD_FILES), asyncHandler(async (req, res) => {
  const current = await getVisibleRequest(routeParam(req.params.code, 'code'), req.authUser!)
  if (!current) throw notFound('Request not found.')
  const meta = z.object({ category: z.enum(['INITIAL_EVIDENCE','INSPECTION_EVIDENCE','RESOLUTION_EVIDENCE','DOCUMENT']).default('DOCUMENT'), visibility: z.enum(['CITIZEN_VISIBLE','INTERNAL']).default('CITIZEN_VISIBLE') }).parse(req.body)
  if (req.authUser!.role === 'CITIZEN' && meta.visibility === 'INTERNAL') throw forbidden()
  const saved = await persistUploads((req.files as Express.Multer.File[] | undefined) ?? [])
  if (!saved.length) throw badRequest('At least one file is required.')
  try {
    const ids: string[] = []
    await withTransaction(async (connection) => {
      for (const file of saved) {
        const id = crypto.randomUUID(); ids.push(id)
        await connection.execute(
          `INSERT INTO request_attachments
           (public_id, request_id, uploaded_by_user_id, category, storage_provider, storage_key, original_filename, mime_type, file_size, sha256, visibility, created_at)
           VALUES (?, ?, ?, ?, 'LOCAL', ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP())`,
          [id, current.id, req.authUser!.id, meta.category, file.storageKey, file.originalFilename, file.mimeType, file.fileSize, file.sha256, req.authUser!.role === 'CITIZEN' ? 'CITIZEN_VISIBLE' : meta.visibility],
        )
      }
      await writeAudit({ actorUserId: req.authUser!.id, action: 'REQUEST_ATTACHMENTS_ADDED', entityType: 'SERVICE_REQUEST', entityId: current.request_code, afterData: { count: saved.length, category: meta.category }, ipAddress: req.ip, userAgent: req.get('user-agent'), requestId: req.requestId }, connection)
    })
    return created(res, { attachmentIds: ids })
  } catch (error) {
    await removePersistedUploads(saved)
    throw error
  }
}))

router.get('/:code/attachments/:attachmentId/download', asyncHandler(async (req, res) => {
  const current = await getVisibleRequest(routeParam(req.params.code, 'code'), req.authUser!)
  if (!current) throw notFound('Request not found.')
  const [rows] = await pool.execute<(RowDataPacket & { storage_key: string; original_filename: string; visibility: string })[]>(
    'SELECT storage_key, original_filename, visibility FROM request_attachments WHERE public_id = ? AND request_id = ? AND deleted_at IS NULL LIMIT 1',
    [req.params.attachmentId, current.id],
  )
  const attachment = rows[0]
  if (!attachment || (req.authUser!.role === 'CITIZEN' && attachment.visibility !== 'CITIZEN_VISIBLE')) throw notFound('Attachment not found.')
  const fullPath = path.resolve(env.UPLOAD_DIR, attachment.storage_key)
  await fs.access(fullPath)
  return res.download(fullPath, attachment.original_filename)
}))

router.delete('/:code', requirePermission('request.delete'), asyncHandler(async (req, res) => {
  const current = await getVisibleRequest(routeParam(req.params.code, 'code'), req.authUser!)
  if (!current) throw notFound('Request not found.')
  await withTransaction(async (connection) => {
    await connection.execute('UPDATE service_requests SET deleted_at = UTC_TIMESTAMP(), deleted_by_user_id = ?, version = version + 1 WHERE id = ?', [req.authUser!.id, current.id])
    await writeAudit({ actorUserId: req.authUser!.id, action: 'REQUEST_SOFT_DELETED', entityType: 'SERVICE_REQUEST', entityId: current.request_code, beforeData: { status: current.status }, ipAddress: req.ip, userAgent: req.get('user-agent'), requestId: req.requestId }, connection)
  })
  return ok(res, { deleted: true, hardDeleted: false })
}))

export default router