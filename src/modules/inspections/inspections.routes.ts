import crypto from 'node:crypto'
import { Router } from 'express'
import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import { z } from 'zod'

import { pool, withTransaction } from '../../config/db'
import { authenticate } from '../../middleware/authenticate'
import { requirePermission } from '../../middleware/authorize'
import { writeAudit } from '../../services/audit.service'
import { createNotification } from '../../services/notification.service'
import { asyncHandler } from '../../utils/asyncHandler'
import { forbidden, notFound, unprocessable } from '../../utils/errors'
import { created, ok } from '../../utils/http'
import { routeParam } from '../../utils/routeParam'

const router = Router()

router.use(authenticate)

/* =========================================================
   VALIDATION
========================================================= */

const createSchema = z.object({
  scheduledFor: z.string().datetime().nullable().optional(),
})

const updateSchema = z
  .object({
    /*
      Status is OPTIONAL.

      This is important for the frontend workflow:

      1. Start inspection:
         PATCH { status: 'IN_PROGRESS' }

      2. Check in at site:
         PATCH { latitude, longitude }

      The officer's GPS is therefore NOT required merely to
      start an inspection.
    */
    status: z
      .enum(['SCHEDULED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'])
      .optional(),

    latitude: z.number().min(-90).max(90).nullable().optional(),

    longitude: z.number().min(-180).max(180).nullable().optional(),

    summary: z.string().trim().max(5000).nullable().optional(),
  })
  .superRefine((value, ctx) => {
    const latitudeProvided =
      value.latitude !== undefined && value.latitude !== null

    const longitudeProvided =
      value.longitude !== undefined && value.longitude !== null

    /*
      Check-in coordinates must always arrive as a pair.
    */
    if (latitudeProvided !== longitudeProvided) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Latitude and longitude must be provided together.',
        path: latitudeProvided ? ['longitude'] : ['latitude'],
      })
    }

    /*
      Do not accept an empty PATCH body.
    */
    const hasAnyUpdate =
      value.status !== undefined ||
      value.latitude !== undefined ||
      value.longitude !== undefined ||
      value.summary !== undefined

    if (!hasAnyUpdate) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'At least one inspection field must be supplied.',
        path: [],
      })
    }
  })

/* =========================================================
   HELPERS
========================================================= */

type RequestRow = RowDataPacket & {
  id: number
  request_code: string
  assigned_to_user_id: number | null
  created_by_user_id: number
  status: string
}

type InspectionRow = RowDataPacket & {
  id: number
  request_id: number
  officer_user_id: number
  status: 'SCHEDULED' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED'
  request_code: string
  created_by_user_id: number
  request_status: string
  start_latitude: number | null
  start_longitude: number | null
}

async function findRequest(code: string) {
  const [rows] = await pool.execute<RequestRow[]>(
    `
      SELECT
        id,
        request_code,
        assigned_to_user_id,
        created_by_user_id,
        status
      FROM service_requests
      WHERE request_code = ?
        AND deleted_at IS NULL
      LIMIT 1
    `,
    [code],
  )

  return rows[0]
}

function isTerminalRequestStatus(status: string) {
  return ['CLOSED', 'REJECTED', 'CANCELLED', 'DUPLICATE'].includes(status)
}

/* =========================================================
   CREATE INSPECTION
   POST /requests/:code/inspections

   IMPORTANT:
   Creating/scheduling an inspection does NOT require GPS.
========================================================= */

router.post(
  '/requests/:code/inspections',
  requirePermission('inspection.manage'),
  asyncHandler(async (req, res) => {
    const input = createSchema.parse(req.body)

    /*
      FIX:
      Express route params may be typed as string | string[].
      Resolve the request code once to a guaranteed string.
    */
    const code = routeParam(
      req.params.code,
      'code',
    )

    const request = await findRequest(code)

    if (!request) {
      throw notFound('Request not found.')
    }

    /*
      A field worker may only work on requests assigned to them.
    */
    if (
      req.authUser!.role === 'GOV_WORKER' &&
      request.assigned_to_user_id !== req.authUser!.id
    ) {
      throw forbidden('This request is not assigned to you.')
    }

    if (!request.assigned_to_user_id) {
      throw unprocessable(
        'Assign the request to a field officer before creating an inspection.',
      )
    }

    if (isTerminalRequestStatus(request.status)) {
      throw unprocessable('This request cannot be inspected.')
    }

    /*
      Avoid accidentally creating multiple active inspections
      for the same request.
    */
    const [activeRows] = await pool.execute<
      (RowDataPacket & {
        public_id: string
        status: string
      })[]
    >(
      `
        SELECT
          public_id,
          status
        FROM inspections
        WHERE request_id = ?
          AND status IN ('SCHEDULED', 'IN_PROGRESS')
        ORDER BY created_at DESC
        LIMIT 1
      `,
      [request.id],
    )

    const existingInspection = activeRows[0]

    if (existingInspection) {
      /*
        Returning the existing inspection makes the endpoint
        safe against accidental double-clicks / stale UI state.
      */
      return ok(res, {
        id: existingInspection.public_id,
        status: existingInspection.status,
        existing: true,
      })
    }

    const publicId = crypto.randomUUID()

    await withTransaction(async (connection) => {
      await connection.execute<ResultSetHeader>(
        `
          INSERT INTO inspections (
            public_id,
            request_id,
            officer_user_id,
            status,
            scheduled_for,
            created_by_user_id,
            created_at,
            updated_at
          )
          VALUES (
            ?,
            ?,
            ?,
            'SCHEDULED',
            ?,
            ?,
            UTC_TIMESTAMP(),
            UTC_TIMESTAMP()
          )
        `,
        [
          publicId,
          request.id,
          request.assigned_to_user_id,
          input.scheduledFor ? new Date(input.scheduledFor) : null,
          req.authUser!.id,
        ],
      )

      /*
        Only move the request to INSPECTION_SCHEDULED when it
        is not already there.
      */
      if (request.status !== 'INSPECTION_SCHEDULED') {
        await connection.execute(
          `
            UPDATE service_requests
            SET
              status = 'INSPECTION_SCHEDULED',
              version = version + 1,
              updated_at = UTC_TIMESTAMP()
            WHERE id = ?
          `,
          [request.id],
        )

        await connection.execute(
          `
            INSERT INTO request_status_history (
              request_id,
              from_status,
              to_status,
              label,
              note,
              changed_by_user_id,
              created_at
            )
            VALUES (
              ?,
              ?,
              'INSPECTION_SCHEDULED',
              'Inspection scheduled',
              NULL,
              ?,
              UTC_TIMESTAMP()
            )
          `,
          [request.id, request.status, req.authUser!.id],
        )
      }

      await createNotification(
        {
          userId: request.created_by_user_id,
          type: 'INSPECTION_SCHEDULED',
          title: 'Inspection scheduled',
          body: `An inspection has been scheduled for ${request.request_code}.`,
          entityType: 'SERVICE_REQUEST',
          entityId: request.request_code,
        },
        connection,
      )

      await writeAudit(
        {
          actorUserId: req.authUser!.id,
          action: 'INSPECTION_CREATED',
          entityType: 'INSPECTION',
          entityId: publicId,
          afterData: {
            requestCode: request.request_code,
            scheduledFor: input.scheduledFor ?? null,
            status: 'SCHEDULED',
          },
          ipAddress: req.ip,
          userAgent: req.get('user-agent'),
          requestId: req.requestId,
        },
        connection,
      )
    })

    return created(res, {
      id: publicId,
      status: 'SCHEDULED',
      existing: false,
    })
  }),
)

/* =========================================================
   LIST REQUEST INSPECTIONS
   GET /requests/:code/inspections
========================================================= */

router.get(
  '/requests/:code/inspections',
  requirePermission('inspection.manage'),
  asyncHandler(async (req, res) => {
    /*
      FIX:
      Resolve the route parameter before passing it to findRequest().
    */
    const code = routeParam(
      req.params.code,
      'code',
    )

    const request = await findRequest(code)

    if (!request) {
      throw notFound('Request not found.')
    }

    if (
      req.authUser!.role === 'GOV_WORKER' &&
      request.assigned_to_user_id !== req.authUser!.id
    ) {
      throw forbidden()
    }

    const [rows] = await pool.execute<RowDataPacket[]>(
      `
        SELECT
          i.public_id AS id,
          i.status,
          i.scheduled_for AS scheduledFor,
          i.started_at AS startedAt,
          i.completed_at AS completedAt,
          i.start_latitude AS startLatitude,
          i.start_longitude AS startLongitude,
          i.summary,
          u.public_id AS officerId,
          u.display_name AS officerName,
          i.created_at AS createdAt,
          i.updated_at AS updatedAt
        FROM inspections i
        JOIN users u
          ON u.id = i.officer_user_id
        WHERE i.request_id = ?
        ORDER BY i.created_at DESC
      `,
      [request.id],
    )

    return ok(res, rows)
  }),
)

/* =========================================================
   UPDATE INSPECTION
   PATCH /inspections/:id

   Supported frontend operations:

   Start:
   {
     "status": "IN_PROGRESS"
   }

   Check in:
   {
     "latitude": 6.927145,
     "longitude": 79.861281
   }

   Also supported for backwards compatibility:
   {
     "status": "IN_PROGRESS",
     "latitude": 6.927145,
     "longitude": 79.861281
   }

   Complete:
   {
     "status": "COMPLETED",
     "summary": "Inspection completed..."
   }
========================================================= */

router.patch(
  '/inspections/:id',
  requirePermission('inspection.manage'),
  asyncHandler(async (req, res) => {
    const input = updateSchema.parse(req.body)

    /*
      FIX:
      Resolve the inspection public id once.
      Use this string for SQL and audit logging below.
    */
    const id = routeParam(
      req.params.id,
      'id',
    )

    const [rows] = await pool.execute<InspectionRow[]>(
      `
        SELECT
          i.id,
          i.request_id,
          i.officer_user_id,
          i.status,
          i.start_latitude,
          i.start_longitude,
          sr.request_code,
          sr.created_by_user_id,
          sr.status AS request_status
        FROM inspections i
        JOIN service_requests sr
          ON sr.id = i.request_id
        WHERE i.public_id = ?
          AND sr.deleted_at IS NULL
        LIMIT 1
      `,
      [id],
    )

    const inspection = rows[0]

    if (!inspection) {
      throw notFound('Inspection not found.')
    }

    if (
      req.authUser!.role === 'GOV_WORKER' &&
      inspection.officer_user_id !== req.authUser!.id
    ) {
      throw forbidden('This inspection is not assigned to you.')
    }

    if (isTerminalRequestStatus(inspection.request_status)) {
      throw unprocessable('This request can no longer be inspected.')
    }

    const latitudeProvided =
      input.latitude !== undefined && input.latitude !== null

    const longitudeProvided =
      input.longitude !== undefined && input.longitude !== null

    const hasCheckInLocation = latitudeProvided && longitudeProvided

    const requestedStatus = input.status
    const statusChanged =
      requestedStatus !== undefined && requestedStatus !== inspection.status

    /*
      A repeated PATCH with the current status is allowed.
      This is useful when older frontend code sends:

      {
        status: 'IN_PROGRESS',
        latitude,
        longitude
      }

      for the check-in action.
    */
    if (statusChanged) {
      const validTransitions: Record<string, string[]> = {
        SCHEDULED: ['IN_PROGRESS', 'CANCELLED'],
        IN_PROGRESS: ['COMPLETED', 'CANCELLED'],
        COMPLETED: [],
        CANCELLED: [],
      }

      if (
        !(validTransitions[inspection.status] ?? []).includes(
          requestedStatus!,
        )
      ) {
        throw unprocessable(
          `Inspection transition ${inspection.status} -> ${requestedStatus} is not allowed.`,
        )
      }
    }

    const effectiveStatus = requestedStatus ?? inspection.status

    /*
      GPS belongs to the explicit "Check in at site" action,
      not to "Start inspection".

      Therefore:
      - SCHEDULED -> IN_PROGRESS does NOT require coordinates.
      - Coordinates may be stored once the inspection is IN_PROGRESS.
    */
    if (hasCheckInLocation && effectiveStatus !== 'IN_PROGRESS') {
      throw unprocessable(
        'Start the inspection before checking in at the site.',
      )
    }

    if (
      requestedStatus === 'COMPLETED' &&
      (!input.summary || !input.summary.trim())
    ) {
      throw unprocessable('Completing an inspection requires a summary.')
    }

    const starting =
      statusChanged && requestedStatus === 'IN_PROGRESS'

    const completing =
      statusChanged && requestedStatus === 'COMPLETED'

    const cancelling =
      statusChanged && requestedStatus === 'CANCELLED'

    await withTransaction(async (connection) => {
      /*
        start_latitude / start_longitude are now used as the
        officer's most recent site check-in coordinates.

        No schema change is required for this version.
      */
      await connection.execute(
        `
          UPDATE inspections
          SET
            status = COALESCE(?, status),

            start_latitude =
              CASE
                WHEN ? THEN ?
                ELSE start_latitude
              END,

            start_longitude =
              CASE
                WHEN ? THEN ?
                ELSE start_longitude
              END,

            started_at =
              CASE
                WHEN ? THEN COALESCE(started_at, UTC_TIMESTAMP())
                ELSE started_at
              END,

            completed_at =
              CASE
                WHEN ? THEN UTC_TIMESTAMP()
                ELSE completed_at
              END,

            summary = COALESCE(?, summary),

            updated_at = UTC_TIMESTAMP()

          WHERE id = ?
        `,
        [
          requestedStatus ?? null,

          hasCheckInLocation,
          hasCheckInLocation ? input.latitude! : null,

          hasCheckInLocation,
          hasCheckInLocation ? input.longitude! : null,

          starting,

          completing,

          input.summary ?? null,

          inspection.id,
        ],
      )

      /*
        Update the parent request only for actual workflow
        transitions. A GPS check-in does not change request status.
      */
      let requestStatus: string | null = null
      let historyLabel: string | null = null
      let historyNote: string | null = null

      if (starting) {
        requestStatus = 'INSPECTING'
        historyLabel = 'Inspection started'
        historyNote = null
      } else if (completing) {
        /*
          Inspection is finished, but the municipal request itself
          may still need action before it is RESOLVED.
        */
        requestStatus = 'IN_PROGRESS'
        historyLabel = 'Inspection completed'
        historyNote = input.summary ?? null
      } else if (cancelling) {
        /*
          Return the request to ASSIGNED so another inspection can
          be scheduled later.
        */
        requestStatus = 'ASSIGNED'
        historyLabel = 'Inspection cancelled'
        historyNote = input.summary ?? null
      }

      if (requestStatus && requestStatus !== inspection.request_status) {
        await connection.execute(
          `
            UPDATE service_requests
            SET
              status = ?,
              version = version + 1,
              updated_at = UTC_TIMESTAMP()
            WHERE id = ?
          `,
          [requestStatus, inspection.request_id],
        )

        await connection.execute(
          `
            INSERT INTO request_status_history (
              request_id,
              from_status,
              to_status,
              label,
              note,
              changed_by_user_id,
              created_at
            )
            VALUES (?, ?, ?, ?, ?, ?, UTC_TIMESTAMP())
          `,
          [
            inspection.request_id,
            inspection.request_status,
            requestStatus,
            historyLabel,
            historyNote,
            req.authUser!.id,
          ],
        )
      }

      /*
        Notify the citizen for meaningful workflow changes.
        Do not send a notification every time the worker checks in.
      */
      if (starting || completing) {
        await createNotification(
          {
            userId: inspection.created_by_user_id,
            type: starting
              ? 'INSPECTION_STARTED'
              : 'INSPECTION_COMPLETED',
            title: starting
              ? 'Inspection started'
              : 'Inspection completed',
            body: `${inspection.request_code} inspection has been ${
              starting ? 'started' : 'completed'
            }.`,
            entityType: 'SERVICE_REQUEST',
            entityId: inspection.request_code,
          },
          connection,
        )
      }

      const auditAction = hasCheckInLocation
        ? statusChanged
          ? `INSPECTION_${requestedStatus}_WITH_CHECK_IN`
          : 'INSPECTION_CHECKED_IN'
        : statusChanged
          ? `INSPECTION_${requestedStatus}`
          : 'INSPECTION_UPDATED'

      await writeAudit(
        {
          actorUserId: req.authUser!.id,
          action: auditAction,
          entityType: 'INSPECTION',
          entityId: id,
          beforeData: {
            status: inspection.status,
            latitude: inspection.start_latitude,
            longitude: inspection.start_longitude,
          },
          afterData: {
            status: requestedStatus ?? inspection.status,
            ...(hasCheckInLocation
              ? {
                  latitude: input.latitude,
                  longitude: input.longitude,
                }
              : {}),
            ...(input.summary !== undefined
              ? {
                  summary: input.summary,
                }
              : {}),
          },
          ipAddress: req.ip,
          userAgent: req.get('user-agent'),
          requestId: req.requestId,
        },
        connection,
      )
    })

    return ok(res, {
      updated: true,
      status: requestedStatus ?? inspection.status,
      checkedIn: hasCheckInLocation,
      ...(hasCheckInLocation
        ? {
            latitude: input.latitude,
            longitude: input.longitude,
          }
        : {}),
    })
  }),
)

export default router
