import { Router } from 'express'
import type {
  RowDataPacket,
} from 'mysql2/promise'
import { z } from 'zod'

import {
  pool,
  withTransaction,
} from '../../config/db'

import {
  authenticate,
} from '../../middleware/authenticate'

import {
  requirePermission,
} from '../../middleware/authorize'

import {
  writeAudit,
} from '../../services/audit.service'

import {
  asyncHandler,
} from '../../utils/asyncHandler'

import {
  badRequest,
  forbidden,
  notFound,
} from '../../utils/errors'

import {
  ok,
} from '../../utils/http'

import {
  routeParam,
} from '../../utils/routeParam'

/* =========================================================
   ROUTER
========================================================= */

const router =
  Router()

router.use(
  authenticate,
)

/* =========================================================
   ROLE HIERARCHY

   IMPORTANT:
   This hierarchy is enforced by the backend.

   Frontend controls are only UI conveniences.
========================================================= */

const ROLE_LEVEL = {
  CITIZEN:
    0,

  GOV_WORKER:
    1,

  GOV_ADMIN:
    2,

  APPROVER:
    3,

  SUPERIOR:
    4,
} as const

type UserRole =
  keyof typeof ROLE_LEVEL

const MANAGER_ROLES:
  UserRole[] = [
    'APPROVER',
    'SUPERIOR',
  ]

/* =========================================================
   VALIDATION
========================================================= */

const accessSchema =
  z.object({
    /*
      CITIZEN MUST be included.

      Otherwise users can be promoted from Citizen,
      but cannot later be downgraded back to Citizen.
    */
    role:
      z.enum([
        'CITIZEN',
        'GOV_WORKER',
        'GOV_ADMIN',
        'APPROVER',
        'SUPERIOR',
      ]),

    departmentId:
      z
        .number()
        .int()
        .positive()
        .nullable()
        .optional(),
  })

const statusSchema =
  z.object({
    status:
      z.enum([
        'ACTIVE',
        'DISABLED',
        'LOCKED',
      ]),
  })

/* =========================================================
   HELPERS
========================================================= */

function getRoleLevel(
  role:
    string,
) {
  const level =
    ROLE_LEVEL[
      role as UserRole
    ]

  if (
    level ===
    undefined
  ) {
    throw forbidden(
      'Unknown user role.',
    )
  }

  return level
}

/*
  Only APPROVER and SUPERIOR can administer access.

  The permission middleware is still required as another
  security boundary, but this explicit role check prevents
  an accidental permission assignment from bypassing the
  hierarchy.
*/
function requireRoleManager(
  actorRole:
    string,
) {
  if (
    !MANAGER_ROLES.includes(
      actorRole as UserRole,
    )
  ) {
    throw forbidden(
      'Only Approval Officers and the Municipal Director may manage user access.',
    )
  }
}

/*
  Actor cannot modify anybody above their own level.
*/
function assertTargetWithinLevel(
  actorRole:
    string,

  targetRole:
    string,
) {
  const actorLevel =
    getRoleLevel(
      actorRole,
    )

  const targetLevel =
    getRoleLevel(
      targetRole,
    )

  if (
    targetLevel >
    actorLevel
  ) {
    throw forbidden(
      'You cannot modify an account above your access level.',
    )
  }
}

/*
  Actor cannot grant a role above their own level.
*/
function assertRequestedRoleWithinLevel(
  actorRole:
    string,

  requestedRole:
    string,
) {
  const actorLevel =
    getRoleLevel(
      actorRole,
    )

  const requestedLevel =
    getRoleLevel(
      requestedRole,
    )

  if (
    requestedLevel >
    actorLevel
  ) {
    throw forbidden(
      'You cannot grant a role above your own access level.',
    )
  }
}

/* =========================================================
   WORKERS

   KEEP THIS ENDPOINT SEPARATE.

   This is intentionally only GOV_WORKER users because it is
   used for request assignment.

   Citizens should NOT appear here.
========================================================= */

router.get(
  '/workers',

  requirePermission(
    'request.assign',
  ),

  asyncHandler(
    async (
      _req,
      res,
    ) => {
      const [rows] =
        await pool.execute<
          RowDataPacket[]
        >(
          `
            SELECT
              u.public_id AS id,
              u.display_name AS name,

              u.department_id AS departmentId,
              d.name AS departmentName

            FROM users u

            JOIN roles r
              ON r.id = u.role_id

            LEFT JOIN departments d
              ON d.id = u.department_id

            WHERE
              r.code = 'GOV_WORKER'
              AND u.status = 'ACTIVE'
              AND u.deleted_at IS NULL

            ORDER BY
              d.name,
              u.display_name
          `,
        )

      return ok(
        res,
        rows,
      )
    },
  ),
)

/* =========================================================
   ALL REGISTERED USERS

   IMPORTANT CHANGE:

   This now returns:

   CITIZEN
   GOV_WORKER
   GOV_ADMIN
   APPROVER
   SUPERIOR

   Therefore Lahiru will appear here.
========================================================= */

router.get(
  '/',

  requirePermission(
    'users.read',
  ),

  asyncHandler(
    async (
      req,
      res,
    ) => {
      const query =
        z
          .object({
            search:
              z
                .string()
                .trim()
                .max(
                  200,
                )
                .optional(),

            role:
              z
                .enum([
                  'CITIZEN',
                  'GOV_WORKER',
                  'GOV_ADMIN',
                  'APPROVER',
                  'SUPERIOR',
                ])
                .optional(),

            departmentId:
              z
                .coerce
                .number()
                .int()
                .positive()
                .optional(),

            status:
              z
                .enum([
                  'ACTIVE',
                  'DISABLED',
                  'LOCKED',
                ])
                .optional(),

            page:
              z
                .coerce
                .number()
                .int()
                .min(
                  1,
                )
                .default(
                  1,
                ),

            limit:
              z
                .coerce
                .number()
                .int()
                .min(
                  1,
                )
                .max(
                  100,
                )
                .default(
                  25,
                ),
          })
          .parse(
            req.query,
          )

      /*
        DO NOT put:

        r.code <> 'CITIZEN'

        here.

        This page is now the complete access directory.
      */
      const where:
        string[] = [
          'u.deleted_at IS NULL',
        ]

      /*
        FIX:
        mysql2 execute() should receive concrete bind-value types.
        This query only pushes strings and numbers.
      */
      const params:
        Array<
          string |
          number
        > = []

      /* ===================================================
         SEARCH
      ==================================================== */

      if (
        query.search
      ) {
        where.push(
          `
            (
              u.display_name LIKE ?
              OR u.first_name LIKE ?
              OR u.last_name LIKE ?
              OR u.email LIKE ?
              OR r.code LIKE ?
              OR d.name LIKE ?
            )
          `,
        )

        const value =
          `%${query.search}%`

        params.push(
          value,
          value,
          value,
          value,
          value,
          value,
        )
      }

      /* ===================================================
         ROLE FILTER
      ==================================================== */

      if (
        query.role
      ) {
        where.push(
          'r.code = ?',
        )

        params.push(
          query.role,
        )
      }

      /* ===================================================
         DEPARTMENT FILTER
      ==================================================== */

      if (
        query.departmentId
      ) {
        where.push(
          'u.department_id = ?',
        )

        params.push(
          query.departmentId,
        )
      }

      /* ===================================================
         STATUS FILTER
      ==================================================== */

      if (
        query.status
      ) {
        where.push(
          'u.status = ?',
        )

        params.push(
          query.status,
        )
      }

      const offset =
        (
          query.page -
          1
        ) *
        query.limit

      /* ===================================================
         USERS
      ==================================================== */

      const [rows] =
        await pool.execute<
          RowDataPacket[]
        >(
          `
            SELECT
              u.public_id AS id,

              u.display_name AS name,

              u.first_name AS firstName,
              u.last_name AS lastName,

              u.email,

              r.code AS role,

              u.status,

              u.department_id AS departmentId,
              d.name AS departmentName,

              u.ward_id AS wardId,

              u.last_login_at AS lastLoginAt,

              u.created_at AS createdAt,
              u.updated_at AS updatedAt

            FROM users u

            JOIN roles r
              ON r.id = u.role_id

            LEFT JOIN departments d
              ON d.id = u.department_id

            WHERE
              ${where.join(
                ' AND ',
              )}

            ORDER BY
              u.display_name

            LIMIT ?
            OFFSET ?
          `,
          [
            ...params,
            query.limit,
            offset,
          ],
        )

      /* ===================================================
         COUNT
      ==================================================== */

      const [counts] =
        await pool.execute<
          (
            RowDataPacket & {
              total:
                number
            }
          )[]
        >(
          `
            SELECT
              COUNT(*) AS total

            FROM users u

            JOIN roles r
              ON r.id = u.role_id

            LEFT JOIN departments d
              ON d.id = u.department_id

            WHERE
              ${where.join(
                ' AND ',
              )}
          `,
          params,
        )

      return ok(
        res,
        rows,
        {
          page:
            query.page,

          limit:
            query.limit,

          total:
            Number(
              counts[0]?.total ??
                0,
            ),
        },
      )
    },
  ),
)

/* =========================================================
   SINGLE USER
========================================================= */

router.get(
  '/:id',

  requirePermission(
    'users.read',
  ),

  asyncHandler(
    async (
      req,
      res,
    ) => {
      /*
        FIX:
        Express route params may be typed as string | string[].
        Resolve the public user id once to a guaranteed string.
      */
      const id =
        routeParam(
          req.params.id,
          'id',
        )

      const [rows] =
        await pool.execute<
          RowDataPacket[]
        >(
          `
            SELECT
              u.public_id AS id,

              u.display_name AS name,

              u.first_name AS firstName,
              u.last_name AS lastName,

              u.email,

              r.code AS role,

              u.status,

              u.department_id AS departmentId,
              d.name AS departmentName,

              u.ward_id AS wardId,

              u.last_login_at AS lastLoginAt,

              u.created_at AS createdAt,
              u.updated_at AS updatedAt

            FROM users u

            JOIN roles r
              ON r.id = u.role_id

            LEFT JOIN departments d
              ON d.id = u.department_id

            WHERE
              u.public_id = ?
              AND u.deleted_at IS NULL

            LIMIT 1
          `,
          [
            id,
          ],
        )

      if (
        !rows[0]
      ) {
        throw notFound(
          'User not found.',
        )
      }

      return ok(
        res,
        rows[0],
      )
    },
  ),
)

/* =========================================================
   CHANGE ACCESS

   NEW RULE:

   APPROVER
   ----------
   may manage Levels 0 - 3
   cannot grant SUPERIOR
   cannot modify SUPERIOR
   cannot modify self

   SUPERIOR
   ----------
   may manage Levels 0 - 4
   cannot modify self
   last active SUPERIOR is protected
========================================================= */

router.patch(
  '/:id/access',

  requirePermission(
    'users.manage',
  ),

  asyncHandler(
    async (
      req,
      res,
    ) => {
      const input =
        accessSchema.parse(
          req.body,
        )

      const actor =
        req.authUser!

      /*
        FIX:
        Resolve the selected user's public id once.
        Use this string for self-checks, SQL, and audit logs.
      */
      const id =
        routeParam(
          req.params.id,
          'id',
        )

      /* ===================================================
         ACTOR MUST BE APPROVER OR SUPERIOR
      ==================================================== */

      requireRoleManager(
        actor.role,
      )

      /* ===================================================
         NEVER CHANGE OWN ROLE
      ==================================================== */

      if (
        id ===
        actor.publicId
      ) {
        throw forbidden(
          'Users cannot change their own role or department.',
        )
      }

      await withTransaction(
        async (
          connection,
        ) => {
          /* ===============================================
             LOCK TARGET USER
          ================================================ */

          const [targets] =
            await connection.execute<
              (
                RowDataPacket & {
                  id:
                    number

                  role:
                    string

                  status:
                    string

                  department_id:
                    number | null
                }
              )[]
            >(
              `
                SELECT
                  u.id,
                  u.status,
                  u.department_id,
                  r.code AS role

                FROM users u

                JOIN roles r
                  ON r.id = u.role_id

                WHERE
                  u.public_id = ?
                  AND u.deleted_at IS NULL

                LIMIT 1

                FOR UPDATE
              `,
              [
                id,
              ],
            )

          const target =
            targets[0]

          if (
            !target
          ) {
            throw notFound(
              'User not found.',
            )
          }

          /* ===============================================
             HIERARCHY CHECK:
             TARGET CANNOT BE ABOVE ACTOR
          ================================================ */

          assertTargetWithinLevel(
            actor.role,
            target.role,
          )

          /* ===============================================
             HIERARCHY CHECK:
             NEW ROLE CANNOT BE ABOVE ACTOR
          ================================================ */

          assertRequestedRoleWithinLevel(
            actor.role,
            input.role,
          )

          /* ===============================================
             PROTECT LAST ACTIVE SUPERIOR
          ================================================ */

          if (
            target.role ===
              'SUPERIOR' &&
            input.role !==
              'SUPERIOR' &&
            target.status ===
              'ACTIVE'
          ) {
            const [others] =
              await connection.execute<
                (
                  RowDataPacket & {
                    count:
                      number
                  }
                )[]
              >(
                `
                  SELECT
                    COUNT(*) AS count

                  FROM users u

                  JOIN roles r
                    ON r.id = u.role_id

                  WHERE
                    r.code = 'SUPERIOR'
                    AND u.status = 'ACTIVE'
                    AND u.deleted_at IS NULL
                    AND u.id <> ?
                `,
                [
                  target.id,
                ],
              )

            if (
              Number(
                others[0]?.count ??
                  0,
              ) <
              1
            ) {
              throw forbidden(
                'The last active Municipal Director cannot be demoted.',
              )
            }
          }

          /* ===============================================
             ROLE MUST EXIST
          ================================================ */

          const [roles] =
            await connection.execute<
              (
                RowDataPacket & {
                  id:
                    number
                }
              )[]
            >(
              `
                SELECT
                  id

                FROM roles

                WHERE
                  code = ?

                LIMIT 1
              `,
              [
                input.role,
              ],
            )

          const role =
            roles[0]

          if (
            !role
          ) {
            throw badRequest(
              'Role is not configured.',
            )
          }

          /* ===============================================
             DEPARTMENT

             Citizens are always public users and should not
             keep a government department.
          ================================================ */

          let nextDepartmentId:
            number | null =
            input.departmentId ??
            null

          if (
            input.role ===
            'CITIZEN'
          ) {
            nextDepartmentId =
              null
          }

          /*
            Field officers and government admins should belong
            to an operating department.
          */
          if (
            (
              input.role ===
                'GOV_WORKER' ||
              input.role ===
                'GOV_ADMIN'
            ) &&
            !nextDepartmentId
          ) {
            throw badRequest(
              'A department is required for Field Officers and Government Administrators.',
            )
          }

          /*
            Validate the selected department instead of waiting
            for a foreign-key error.
          */
          if (
            nextDepartmentId
          ) {
            const [departmentRows] =
              await connection.execute<
                RowDataPacket[]
              >(
                `
                  SELECT
                    id

                  FROM departments

                  WHERE
                    id = ?

                  LIMIT 1
                `,
                [
                  nextDepartmentId,
                ],
              )

            if (
              !departmentRows[0]
            ) {
              throw badRequest(
                'Selected department does not exist.',
              )
            }
          }

          /* ===============================================
             UPDATE USER
          ================================================ */

          await connection.execute(
            `
              UPDATE users

              SET
                role_id = ?,
                department_id = ?,
                updated_at = UTC_TIMESTAMP()

              WHERE
                id = ?
            `,
            [
              role.id,
              nextDepartmentId,
              target.id,
            ],
          )

          /* ===============================================
             REVOKE ACTIVE SESSIONS

             Role changes must take effect immediately.
          ================================================ */

          await connection.execute(
            `
              UPDATE user_sessions

              SET
                revoked_at = UTC_TIMESTAMP()

              WHERE
                user_id = ?
                AND revoked_at IS NULL
            `,
            [
              target.id,
            ],
          )

          /* ===============================================
             AUDIT
          ================================================ */

          await writeAudit(
            {
              actorUserId:
                actor.id,

              action:
                'USER_ACCESS_CHANGED',

              entityType:
                'USER',

              entityId:
                id,

              beforeData: {
                role:
                  target.role,

                departmentId:
                  target.department_id,
              },

              afterData: {
                role:
                  input.role,

                departmentId:
                  nextDepartmentId,
              },

              ipAddress:
                req.ip,

              userAgent:
                req.get(
                  'user-agent',
                ),

              requestId:
                req.requestId,
            },

            connection,
          )
        },
      )

      return ok(
        res,
        {
          updated:
            true,

          sessionsRevoked:
            true,
        },
      )
    },
  ),
)

/* =========================================================
   CHANGE ACCOUNT STATUS

   The SAME hierarchy applies.

   An Approver cannot disable a Superior.
========================================================= */

router.patch(
  '/:id/status',

  requirePermission(
    'users.manage',
  ),

  asyncHandler(
    async (
      req,
      res,
    ) => {
      const input =
        statusSchema.parse(
          req.body,
        )

      const actor =
        req.authUser!

      /*
        FIX:
        Resolve the selected user's public id once.
      */
      const id =
        routeParam(
          req.params.id,
          'id',
        )

      requireRoleManager(
        actor.role,
      )

      if (
        id ===
        actor.publicId
      ) {
        throw forbidden(
          'Users cannot disable or lock their own account.',
        )
      }

      await withTransaction(
        async (
          connection,
        ) => {
          const [targets] =
            await connection.execute<
              (
                RowDataPacket & {
                  id:
                    number

                  status:
                    string

                  role:
                    string
                }
              )[]
            >(
              `
                SELECT
                  u.id,
                  u.status,
                  r.code AS role

                FROM users u

                JOIN roles r
                  ON r.id = u.role_id

                WHERE
                  u.public_id = ?
                  AND u.deleted_at IS NULL

                LIMIT 1

                FOR UPDATE
              `,
              [
                id,
              ],
            )

          const target =
            targets[0]

          if (
            !target
          ) {
            throw notFound(
              'User not found.',
            )
          }

          /* ===============================================
             CANNOT MANAGE ABOVE OWN LEVEL
          ================================================ */

          assertTargetWithinLevel(
            actor.role,
            target.role,
          )

          /* ===============================================
             LAST SUPERIOR PROTECTION
          ================================================ */

          if (
            target.role ===
              'SUPERIOR' &&
            target.status ===
              'ACTIVE' &&
            input.status !==
              'ACTIVE'
          ) {
            const [others] =
              await connection.execute<
                (
                  RowDataPacket & {
                    count:
                      number
                  }
                )[]
              >(
                `
                  SELECT
                    COUNT(*) AS count

                  FROM users u

                  JOIN roles r
                    ON r.id = u.role_id

                  WHERE
                    r.code = 'SUPERIOR'
                    AND u.status = 'ACTIVE'
                    AND u.deleted_at IS NULL
                    AND u.id <> ?
                `,
                [
                  target.id,
                ],
              )

            if (
              Number(
                others[0]?.count ??
                  0,
              ) <
              1
            ) {
              throw forbidden(
                'The last active Municipal Director cannot be disabled or locked.',
              )
            }
          }

          /* ===============================================
             UPDATE STATUS
          ================================================ */

          await connection.execute(
            `
              UPDATE users

              SET
                status = ?,

                disabled_at =
                  CASE
                    WHEN ? = 'DISABLED'
                      THEN UTC_TIMESTAMP()
                    ELSE NULL
                  END,

                updated_at =
                  UTC_TIMESTAMP()

              WHERE
                id = ?
            `,
            [
              input.status,
              input.status,
              target.id,
            ],
          )

          /* ===============================================
             REVOKE SESSION IF ACCOUNT IS NOT ACTIVE
          ================================================ */

          if (
            input.status !==
            'ACTIVE'
          ) {
            await connection.execute(
              `
                UPDATE user_sessions

                SET
                  revoked_at = UTC_TIMESTAMP()

                WHERE
                  user_id = ?
                  AND revoked_at IS NULL
              `,
              [
                target.id,
              ],
            )
          }

          /* ===============================================
             AUDIT
          ================================================ */

          await writeAudit(
            {
              actorUserId:
                actor.id,

              action:
                'USER_STATUS_CHANGED',

              entityType:
                'USER',

              entityId:
                id,

              beforeData: {
                status:
                  target.status,
              },

              afterData: {
                status:
                  input.status,
              },

              ipAddress:
                req.ip,

              userAgent:
                req.get(
                  'user-agent',
                ),

              requestId:
                req.requestId,
            },

            connection,
          )
        },
      )

      return ok(
        res,
        {
          updated:
            true,
        },
      )
    },
  ),
)

/* =========================================================
   USER AUDIT

   FIXED:

   Your old version queried logs where the selected user was
   the ACTOR.

   For an access-review screen we want actions performed ON
   the selected user.
========================================================= */

router.get(
  '/:id/audit',

  requirePermission(
    'audit.read',
  ),

  asyncHandler(
    async (
      req,
      res,
    ) => {
      /*
        FIX:
        Resolve the selected user's public id before using it
        as the audit entity id.
      */
      const id =
        routeParam(
          req.params.id,
          'id',
        )

      const [rows] =
        await pool.execute<
          RowDataPacket[]
        >(
          `
            SELECT
              a.action,

              a.entity_type AS entityType,
              a.entity_id AS entityId,

              a.before_data AS beforeData,
              a.after_data AS afterData,

              a.ip_address AS ipAddress,

              a.created_at AS createdAt,

              actor.public_id AS actorId,
              actor.display_name AS actorName

            FROM audit_logs a

            LEFT JOIN users actor
              ON actor.id = a.actor_user_id

            WHERE
              a.entity_type = 'USER'
              AND a.entity_id = ?

            ORDER BY
              a.created_at DESC

            LIMIT 200
          `,
          [
            id,
          ],
        )

      return ok(
        res,
        rows,
      )
    },
  ),
)

export default router