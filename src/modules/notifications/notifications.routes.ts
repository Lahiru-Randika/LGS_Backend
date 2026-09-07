import { Router } from 'express'
import type {
  ResultSetHeader,
  RowDataPacket,
} from 'mysql2/promise'

import { pool } from '../../config/db'
import { authenticate } from '../../middleware/authenticate'
import { asyncHandler } from '../../utils/asyncHandler'
import { notFound } from '../../utils/errors'
import { ok } from '../../utils/http'
import { routeParam } from '../../utils/routeParam'

const router =
  Router()

router.use(
  authenticate,
)

/* =========================================================
   GET NOTIFICATIONS
========================================================= */

router.get(
  '/',
  asyncHandler(
    async (
      req,
      res,
    ) => {
      const [
        rows,
      ] =
        await pool.execute<
          RowDataPacket[]
        >(
          `
          SELECT
            public_id AS id,
            type,
            title,
            body,
            entity_type AS entityType,
            entity_id AS entityId,
            tone,
            read_at AS readAt,
            created_at AS createdAt

          FROM notifications

          WHERE
            user_id = ?

          ORDER BY
            created_at DESC

          LIMIT 100
          `,
          [
            req.authUser!.id,
          ],
        )

      return ok(
        res,
        rows,
      )
    },
  ),
)

/* =========================================================
   GET UNREAD COUNT
========================================================= */

router.get(
  '/unread-count',
  asyncHandler(
    async (
      req,
      res,
    ) => {
      const [
        rows,
      ] =
        await pool.execute<
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

          FROM notifications

          WHERE
            user_id = ?
            AND read_at IS NULL
          `,
          [
            req.authUser!.id,
          ],
        )

      return ok(
        res,
        {
          count:
            rows[0]?.count ??
            0,
        },
      )
    },
  ),
)

/* =========================================================
   MARK ONE NOTIFICATION AS READ
========================================================= */

router.patch(
  '/:id/read',
  asyncHandler(
    async (
      req,
      res,
    ) => {
      /*
        FIX:
        Express route params may be typed as:
          string | string[]

        Resolve it once to a guaranteed string.
      */
      const id =
        routeParam(
          req.params.id,
          'id',
        )

      const [
        result,
      ] =
        await pool.execute<
          ResultSetHeader
        >(
          `
          UPDATE notifications

          SET
            read_at =
              COALESCE(
                read_at,
                UTC_TIMESTAMP()
              )

          WHERE
            public_id = ?
            AND user_id = ?
          `,
          [
            id,
            req.authUser!.id,
          ],
        )

      if (
        result.affectedRows !==
        1
      ) {
        throw notFound(
          'Notification not found.',
        )
      }

      return ok(
        res,
        {
          read:
            true,
        },
      )
    },
  ),
)

/* =========================================================
   MARK ALL NOTIFICATIONS AS READ
========================================================= */

router.post(
  '/read-all',
  asyncHandler(
    async (
      req,
      res,
    ) => {
      await pool.execute(
        `
        UPDATE notifications

        SET
          read_at =
            COALESCE(
              read_at,
              UTC_TIMESTAMP()
            )

        WHERE
          user_id = ?
        `,
        [
          req.authUser!.id,
        ],
      )

      return ok(
        res,
        {
          readAll:
            true,
        },
      )
    },
  ),
)

export default router
