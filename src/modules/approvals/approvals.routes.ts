import crypto from 'node:crypto'
import { Router } from 'express'
import type { RowDataPacket } from 'mysql2/promise'
import { z } from 'zod'

import { pool, withTransaction } from '../../config/db'
import { authenticate } from '../../middleware/authenticate'
import { requirePermission } from '../../middleware/authorize'
import { writeAudit } from '../../services/audit.service'
import { createNotification } from '../../services/notification.service'
import { asyncHandler } from '../../utils/asyncHandler'
import { badRequest, notFound, unprocessable } from '../../utils/errors'
import { created, ok } from '../../utils/http'
import { routeParam } from '../../utils/routeParam'

const router = Router()

router.use(authenticate)

const submitSchema = z.object({
  approvalType: z.enum([
    'REQUEST_ACTION',
    'BOOKING',
    'EXPENDITURE',
    'OTHER',
  ]),
  requestedAction: z.string().trim().min(3).max(500),
  justification: z.string().trim().min(5).max(5000),
  assignedToUserId: z.string().uuid().nullable().optional(),
  dueAt: z.string().datetime().nullable().optional(),
})

const decisionSchema = z.object({
  decision: z.enum([
    'APPROVE',
    'REJECT',
    'REQUEST_INFO',
  ]),
  rationale: z.string().trim().min(5).max(5000),
})

router.get(
  '/approvals',
  requirePermission('approval.manage'),
  asyncHandler(async (req, res) => {
    const q = z.object({
      status: z.enum([
        'PENDING',
        'APPROVED',
        'REJECTED',
        'INFO_REQUESTED',
        'CANCELLED',
      ]).optional(),
      page: z.coerce.number().int().min(1).default(1),
      limit: z.coerce.number().int().min(1).max(100).default(25),
    }).parse(req.query)

    const where: string[] = ['1=1']

    // FIX 1:
    // mysql2 cannot safely accept unknown[] as execute parameters.
    // These query parameters are only strings/numbers.
    const params: Array<string | number> = []

    if (q.status) {
      where.push('a.status = ?')
      params.push(q.status)
    }

    if (req.authUser!.role === 'APPROVER') {
      where.push(
        '(a.assigned_to_user_id IS NULL OR a.assigned_to_user_id = ?)',
      )
      params.push(req.authUser!.id)
    }

    const offset = (q.page - 1) * q.limit

    const [rows] = await pool.execute<RowDataPacket[]>(
      `SELECT
         a.public_id AS id,
         a.status,
         a.approval_type AS approvalType,
         a.requested_action AS requestedAction,
         a.justification,
         a.due_at AS dueAt,
         a.created_at AS createdAt,
         a.decided_at AS decidedAt,
         sr.request_code AS requestCode,
         sr.title AS requestTitle,
         sr.priority,
         submitter.display_name AS submittedBy,
         assignee.public_id AS assignedToId,
         assignee.display_name AS assignedToName
       FROM approval_requests a
       JOIN service_requests sr
         ON sr.id = a.request_id
       JOIN users submitter
         ON submitter.id = a.submitted_by_user_id
       LEFT JOIN users assignee
         ON assignee.id = a.assigned_to_user_id
       WHERE ${where.join(' AND ')}
       ORDER BY a.created_at DESC
       LIMIT ?
       OFFSET ?`,
      [
        ...params,
        q.limit,
        offset,
      ],
    )

    const [counts] = await pool.execute<
      (RowDataPacket & { total: number })[]
    >(
      `SELECT COUNT(*) AS total
       FROM approval_requests a
       WHERE ${where.join(' AND ')}`,
      params,
    )

    return ok(
      res,
      rows,
      {
        page: q.page,
        limit: q.limit,
        total: counts[0]?.total ?? 0,
      },
    )
  }),
)

router.post(
  '/requests/:code/approvals',
  requirePermission('approval.submit'),
  asyncHandler(async (req, res) => {
    const input = submitSchema.parse(req.body)

    // FIX 2:
    // Express route params are typed as string | string[].
    // Convert once and use the resolved string everywhere.
    const code = routeParam(
      req.params.code,
      'code',
    )

    const [requests] = await pool.execute<
      (
        RowDataPacket & {
          id: number
          request_code: string
          status: string
          created_by_user_id: number
        }
      )[]
    >(
      `SELECT
         id,
         request_code,
         status,
         created_by_user_id
       FROM service_requests
       WHERE request_code = ?
         AND deleted_at IS NULL
       LIMIT 1`,
      [code],
    )

    const request = requests[0]

    if (!request) {
      throw notFound('Request not found.')
    }

    if (
      [
        'CLOSED',
        'REJECTED',
        'CANCELLED',
        'DUPLICATE',
      ].includes(request.status)
    ) {
      throw unprocessable(
        'This request cannot be submitted for approval.',
      )
    }

    let assignedToId: number | null = null

    if (input.assignedToUserId) {
      const [approvers] = await pool.execute<
        (RowDataPacket & { id: number })[]
      >(
        `SELECT u.id
         FROM users u
         JOIN roles r
           ON r.id = u.role_id
         WHERE u.public_id = ?
           AND r.code IN ('APPROVER','SUPERIOR')
           AND u.status = 'ACTIVE'
           AND u.deleted_at IS NULL
         LIMIT 1`,
        [input.assignedToUserId],
      )

      if (!approvers[0]) {
        throw badRequest(
          'Assigned approver must be an active APPROVER or SUPERIOR.',
        )
      }

      assignedToId = approvers[0].id
    }

    const publicId = crypto.randomUUID()

    await withTransaction(async (connection) => {
      await connection.execute(
        `INSERT INTO approval_requests
         (
           public_id,
           request_id,
           approval_type,
           requested_action,
           justification,
           submitted_by_user_id,
           assigned_to_user_id,
           status,
           due_at,
           created_at
         )
         VALUES (
           ?,
           ?,
           ?,
           ?,
           ?,
           ?,
           ?,
           'PENDING',
           ?,
           UTC_TIMESTAMP()
         )`,
        [
          publicId,
          request.id,
          input.approvalType,
          input.requestedAction,
          input.justification,
          req.authUser!.id,
          assignedToId,
          input.dueAt
            ? new Date(input.dueAt)
            : null,
        ],
      )

      await connection.execute(
        `UPDATE service_requests
         SET
           status = 'AWAITING_APPROVAL',
           version = version + 1,
           updated_at = UTC_TIMESTAMP()
         WHERE id = ?`,
        [request.id],
      )

      await connection.execute(
        `INSERT INTO request_status_history
         (
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
           'AWAITING_APPROVAL',
           'Awaiting approval',
           ?,
           ?,
           UTC_TIMESTAMP()
         )`,
        [
          request.id,
          request.status,
          input.justification,
          req.authUser!.id,
        ],
      )

      if (assignedToId) {
        await createNotification(
          {
            userId: assignedToId,
            type: 'APPROVAL_REQUIRED',
            title: 'Approval required',
            body:
              `${request.request_code} is waiting for your decision.`,
            entityType: 'APPROVAL',
            entityId: publicId,
            tone: 'WARNING',
          },
          connection,
        )
      }

      await createNotification(
        {
          userId: request.created_by_user_id,
          type: 'AWAITING_APPROVAL',
          title: 'Request sent for approval',
          body:
            `${request.request_code} is awaiting a formal municipal decision.`,
          entityType: 'SERVICE_REQUEST',
          entityId: request.request_code,
        },
        connection,
      )

      await writeAudit(
        {
          actorUserId: req.authUser!.id,
          action: 'APPROVAL_SUBMITTED',
          entityType: 'APPROVAL',
          entityId: publicId,
          afterData: input,
          ipAddress: req.ip,
          userAgent: req.get('user-agent'),
          requestId: req.requestId,
        },
        connection,
      )
    })

    return created(
      res,
      {
        id: publicId,
        status: 'PENDING',
      },
    )
  }),
)

router.post(
  '/approvals/:id/decisions',
  requirePermission('approval.manage'),
  asyncHandler(async (req, res) => {
    const input = decisionSchema.parse(req.body)

    // FIX 3:
    // Resolve the approval id once.
    const id = routeParam(
      req.params.id,
      'id',
    )

    const [rows] = await pool.execute<
      (
        RowDataPacket & {
          id: number
          request_id: number
          status: string
          request_code: string
          created_by_user_id: number
          assigned_to_user_id: number | null
        }
      )[]
    >(
      `SELECT
         a.id,
         a.request_id,
         a.status,
         sr.request_code,
         sr.created_by_user_id,
         a.assigned_to_user_id
       FROM approval_requests a
       JOIN service_requests sr
         ON sr.id = a.request_id
       WHERE a.public_id = ?
       LIMIT 1`,
      [
        // FIX 4:
        // Use id:string instead of req.params.id.
        id,
      ],
    )

    const approval = rows[0]

    if (!approval) {
      throw notFound(
        'Approval request not found.',
      )
    }

    if (
      approval.status !== 'PENDING' &&
      approval.status !== 'INFO_REQUESTED'
    ) {
      throw unprocessable(
        'This approval is no longer pending.',
      )
    }

    if (
      req.authUser!.role === 'APPROVER' &&
      approval.assigned_to_user_id &&
      approval.assigned_to_user_id !== req.authUser!.id
    ) {
      throw unprocessable(
        'This approval is assigned to another approver.',
      )
    }

    const approvalStatus =
      input.decision === 'APPROVE'
        ? 'APPROVED'
        : input.decision === 'REJECT'
          ? 'REJECTED'
          : 'INFO_REQUESTED'

    const requestStatus =
      input.decision === 'APPROVE'
        ? 'IN_PROGRESS'
        : input.decision === 'REJECT'
          ? 'REJECTED'
          : 'NEEDS_APPROVAL'

    await withTransaction(async (connection) => {
      const [requestRows] = await connection.execute<
        (RowDataPacket & { status: string })[]
      >(
        `SELECT status
         FROM service_requests
         WHERE id = ?
         FOR UPDATE`,
        [approval.request_id],
      )

      const fromStatus =
        requestRows[0]?.status ??
        'AWAITING_APPROVAL'

      await connection.execute(
        `INSERT INTO approval_decisions
         (
           approval_request_id,
           decision,
           rationale,
           decided_by_user_id,
           created_at
         )
         VALUES (
           ?,
           ?,
           ?,
           ?,
           UTC_TIMESTAMP()
         )`,
        [
          approval.id,
          input.decision,
          input.rationale,
          req.authUser!.id,
        ],
      )

      await connection.execute(
        `UPDATE approval_requests
         SET
           status = ?,
           decided_at =
             CASE
               WHEN ? IN ('APPROVED','REJECTED')
               THEN UTC_TIMESTAMP()
               ELSE NULL
             END,
           updated_at = UTC_TIMESTAMP()
         WHERE id = ?`,
        [
          approvalStatus,
          approvalStatus,
          approval.id,
        ],
      )

      await connection.execute(
        `UPDATE service_requests
         SET
           status = ?,
           version = version + 1,
           updated_at = UTC_TIMESTAMP()
         WHERE id = ?`,
        [
          requestStatus,
          approval.request_id,
        ],
      )

      await connection.execute(
        `INSERT INTO request_status_history
         (
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
           ?,
           ?,
           ?,
           ?,
           UTC_TIMESTAMP()
         )`,
        [
          approval.request_id,
          fromStatus,
          requestStatus,
          input.decision.replaceAll('_', ' '),
          input.rationale,
          req.authUser!.id,
        ],
      )

      await createNotification(
        {
          userId: approval.created_by_user_id,
          type: 'APPROVAL_DECISION',
          title:
            `Approval ${approvalStatus
              .toLowerCase()
              .replaceAll('_', ' ')}`,
          body:
            `${approval.request_code}: ${input.rationale}`,
          entityType: 'APPROVAL',

          // FIX 5:
          // Notification expects string | null.
          entityId: id,

          tone:
            input.decision === 'APPROVE'
              ? 'SUCCESS'
              : 'WARNING',
        },
        connection,
      )

      await writeAudit(
        {
          actorUserId: req.authUser!.id,
          action:
            `APPROVAL_${input.decision}`,
          entityType: 'APPROVAL',

          // FIX 6:
          // Audit entityId accepts string/number, but
          // req.params.id can be string[] in the typings.
          entityId: id,

          beforeData: {
            status: approval.status,
          },

          afterData: {
            status: approvalStatus,
            rationale: input.rationale,
          },

          ipAddress: req.ip,
          userAgent:
            req.get('user-agent'),
          requestId: req.requestId,
        },
        connection,
      )
    })

    return ok(
      res,
      {
        decision: input.decision,
        approvalStatus,
        requestStatus,
      },
    )
  }),
)

export default router