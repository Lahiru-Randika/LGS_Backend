import crypto from 'node:crypto'
import { Router } from 'express'
import type {
  ResultSetHeader,
  RowDataPacket,
} from 'mysql2/promise'
import { z } from 'zod'

import { pool } from '../../config/db'
import { authenticate } from '../../middleware/authenticate'
import { requirePermission } from '../../middleware/authorize'
import { writeAudit } from '../../services/audit.service'
import { asyncHandler } from '../../utils/asyncHandler'
import { notFound } from '../../utils/errors'
import { created, ok } from '../../utils/http'
import { routeParam } from '../../utils/routeParam'

const router = Router()

router.use(authenticate)

const newsSchema = z.object({
  slug: z
    .string()
    .trim()
    .min(3)
    .max(255)
    .regex(
      /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
    ),

  category: z
    .string()
    .trim()
    .min(1)
    .max(80),

  title: z
    .string()
    .trim()
    .min(3)
    .max(255),

  summary: z
    .string()
    .trim()
    .min(5)
    .max(1000),

  body: z
    .string()
    .trim()
    .min(10)
    .max(100000),

  coverImageKey: z
    .string()
    .trim()
    .max(1000)
    .nullable()
    .optional(),

  status: z
    .enum([
      'DRAFT',
      'PUBLISHED',
      'ARCHIVED',
    ])
    .default('DRAFT'),

  publishedAt: z
    .string()
    .datetime()
    .nullable()
    .optional(),
})

/* =========================================================
   GET NEWS
========================================================= */

router.get(
  '/news',
  requirePermission(
    'news.manage',
  ),
  asyncHandler(
    async (
      _req,
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
            slug,
            category,
            title,
            summary,
            status,
            published_at AS publishedAt,
            created_at AS createdAt,
            updated_at AS updatedAt

          FROM news_posts

          ORDER BY
            created_at DESC

          LIMIT 200
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
   CREATE NEWS
========================================================= */

router.post(
  '/news',
  requirePermission(
    'news.manage',
  ),
  asyncHandler(
    async (
      req,
      res,
    ) => {
      const input =
        newsSchema.parse(
          req.body,
        )

      const id =
        crypto.randomUUID()

      const publishedAt =
        input.status ===
        'PUBLISHED'
          ? input.publishedAt
            ? new Date(
                input.publishedAt,
              )
            : new Date()
          : input.publishedAt
            ? new Date(
                input.publishedAt,
              )
            : null

      await pool.execute(
        `
        INSERT INTO news_posts (
          public_id,
          slug,
          category,
          title,
          summary,
          body,
          cover_image_key,
          status,
          published_at,
          created_by_user_id,
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
          ?,
          ?,
          ?,
          UTC_TIMESTAMP()
        )
        `,
        [
          id,
          input.slug,
          input.category,
          input.title,
          input.summary,
          input.body,
          input.coverImageKey ??
            null,
          input.status,
          publishedAt,
          req.authUser!.id,
        ],
      )

      await writeAudit(
        {
          actorUserId:
            req.authUser!.id,

          action:
            'NEWS_CREATED',

          entityType:
            'NEWS_POST',

          entityId:
            id,

          afterData: {
            slug:
              input.slug,

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
      )

      return created(
        res,
        {
          id,
        },
      )
    },
  ),
)

/* =========================================================
   UPDATE NEWS
========================================================= */

router.patch(
  '/news/:id',
  requirePermission(
    'news.manage',
  ),
  asyncHandler(
    async (
      req,
      res,
    ) => {
      const input =
        newsSchema
          .partial()
          .parse(
            req.body,
          )

      /*
        FIX 1:
        Express route params may be typed as:
          string | string[]

        Resolve once to a guaranteed string.
      */
      const id =
        routeParam(
          req.params.id,
          'id',
        )

      const [
        currentRows,
      ] =
        await pool.execute<
          (
            RowDataPacket & {
              id: number
              slug: string
              status: string
            }
          )[]
        >(
          `
          SELECT
            id,
            slug,
            status

          FROM news_posts

          WHERE
            public_id = ?

          LIMIT 1
          `,
          [
            id,
          ],
        )

      const current =
        currentRows[0]

      if (
        !current
      ) {
        throw notFound(
          'News post not found.',
        )
      }

      const sets:
        string[] = []

      /*
        FIX 2:
        Do not use unknown[] for mysql2 parameters.

        These update values can be strings, numbers,
        Date objects or null.
      */
      const params:
        Array<
          string |
          number |
          Date |
          null
        > = []

      const add =
        (
          column:
            string,

          value:
            string |
            number |
            Date |
            null,
        ) => {
          sets.push(
            `${column} = ?`,
          )

          params.push(
            value,
          )
        }

      if (
        input.slug !==
        undefined
      ) {
        add(
          'slug',
          input.slug,
        )
      }

      if (
        input.category !==
        undefined
      ) {
        add(
          'category',
          input.category,
        )
      }

      if (
        input.title !==
        undefined
      ) {
        add(
          'title',
          input.title,
        )
      }

      if (
        input.summary !==
        undefined
      ) {
        add(
          'summary',
          input.summary,
        )
      }

      if (
        input.body !==
        undefined
      ) {
        add(
          'body',
          input.body,
        )
      }

      if (
        input.coverImageKey !==
        undefined
      ) {
        add(
          'cover_image_key',
          input.coverImageKey,
        )
      }

      if (
        input.status !==
        undefined
      ) {
        add(
          'status',
          input.status,
        )

        if (
          input.status ===
            'PUBLISHED' &&
          input.publishedAt ===
            undefined
        ) {
          sets.push(
            'published_at = COALESCE(published_at, UTC_TIMESTAMP())',
          )
        }
      }

      if (
        input.publishedAt !==
        undefined
      ) {
        add(
          'published_at',
          input.publishedAt
            ? new Date(
                input.publishedAt,
              )
            : null,
        )
      }

      if (
        !sets.length
      ) {
        return ok(
          res,
          {
            updated:
              false,
          },
        )
      }

      sets.push(
        'updated_at = UTC_TIMESTAMP()',
      )

      await pool.execute<
        ResultSetHeader
      >(
        `
        UPDATE news_posts

        SET
          ${sets.join(', ')}

        WHERE
          id = ?
        `,
        [
          ...params,
          current.id,
        ],
      )

      await writeAudit(
        {
          actorUserId:
            req.authUser!.id,

          action:
            'NEWS_UPDATED',

          entityType:
            'NEWS_POST',

          /*
            FIX 3:
            Use resolved string id.
          */
          entityId:
            id,

          beforeData: {
            slug:
              current.slug,

            status:
              current.status,
          },

          afterData:
            input,

          ipAddress:
            req.ip,

          userAgent:
            req.get(
              'user-agent',
            ),

          requestId:
            req.requestId,
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
   ARCHIVE NEWS
========================================================= */

router.delete(
  '/news/:id',
  requirePermission(
    'news.manage',
  ),
  asyncHandler(
    async (
      req,
      res,
    ) => {
      /*
        FIX 4:
        Resolve route id before using it in SQL/audit.
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
          UPDATE news_posts

          SET
            status = 'ARCHIVED',
            updated_at = UTC_TIMESTAMP()

          WHERE
            public_id = ?
          `,
          [
            id,
          ],
        )

      if (
        result.affectedRows !==
        1
      ) {
        throw notFound(
          'News post not found.',
        )
      }

      await writeAudit(
        {
          actorUserId:
            req.authUser!.id,

          action:
            'NEWS_ARCHIVED',

          entityType:
            'NEWS_POST',

          entityId:
            id,

          ipAddress:
            req.ip,

          userAgent:
            req.get(
              'user-agent',
            ),

          requestId:
            req.requestId,
        },
      )

      return ok(
        res,
        {
          archived:
            true,
        },
      )
    },
  ),
)

/* =========================================================
   GET CONTACT MESSAGES
========================================================= */

router.get(
  '/contact-messages',
  requirePermission(
    'contact.manage',
  ),
  asyncHandler(
    async (
      req,
      res,
    ) => {
      const q =
        z.object({
          status: z
            .enum([
              'NEW',
              'READ',
              'REPLIED',
              'ARCHIVED',
            ])
            .optional(),
        })
          .parse(
            req.query,
          )

      const [
        rows,
      ] =
        await pool.execute<
          RowDataPacket[]
        >(
          `
          SELECT
            public_id AS id,
            name,
            email,
            subject,
            message,
            status,
            created_at AS createdAt,
            updated_at AS updatedAt

          FROM contact_messages

          ${
            q.status
              ? 'WHERE status = ?'
              : ''
          }

          ORDER BY
            created_at DESC

          LIMIT 200
          `,
          q.status
            ? [
                q.status,
              ]
            : [],
        )

      return ok(
        res,
        rows,
      )
    },
  ),
)

/* =========================================================
   UPDATE CONTACT MESSAGE STATUS
========================================================= */

router.patch(
  '/contact-messages/:id/status',
  requirePermission(
    'contact.manage',
  ),
  asyncHandler(
    async (
      req,
      res,
    ) => {
      const input =
        z.object({
          status: z.enum([
            'NEW',
            'READ',
            'REPLIED',
            'ARCHIVED',
          ]),
        })
          .parse(
            req.body,
          )

      /*
        FIX 5:
        Resolve contact message id once.
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
          UPDATE contact_messages

          SET
            status = ?,
            updated_at = UTC_TIMESTAMP()

          WHERE
            public_id = ?
          `,
          [
            input.status,
            id,
          ],
        )

      if (
        result.affectedRows !==
        1
      ) {
        throw notFound(
          'Contact message not found.',
        )
      }

      await writeAudit(
        {
          actorUserId:
            req.authUser!.id,

          action:
            'CONTACT_MESSAGE_STATUS_CHANGED',

          entityType:
            'CONTACT_MESSAGE',

          entityId:
            id,

          afterData:
            input,

          ipAddress:
            req.ip,

          userAgent:
            req.get(
              'user-agent',
            ),

          requestId:
            req.requestId,
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

export default router