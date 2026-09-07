import {
  Router,
} from 'express'

import type {
  ResultSetHeader,
  RowDataPacket,
} from 'mysql2/promise'

import {
  z,
} from 'zod'

import {
  pool,
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
  notFound,
} from '../../utils/errors'

import {
  created,
  ok,
} from '../../utils/http'

const router =
  Router()

router.use(
  authenticate,
)

/* =========================================================
   HELPERS
========================================================= */

function routeParam(
  value:
    string |
    string[] |
    undefined,

  name:
    string,
) {
  const resolved =
    Array.isArray(
      value,
    )
      ? value[0]
      : value

  if (
    !resolved
  ) {
    throw new Error(
      `Missing route parameter: ${name}`,
    )
  }

  return resolved
}

/* =========================================================
   LIST / SEARCH BUILDINGS

   GET /api/v1/buildings

   Examples:

   /buildings?search=nelum
   /buildings?search=LGS-BLD-000123
   /buildings?search=Bauddhaloka
   /buildings?latitude=6.9103&longitude=79.8615
   /buildings?latitude=6.9103&longitude=79.8615&radiusMeters=100
========================================================= */

router.get(
  '/',

  requirePermission(
    'building.sensitive.read',
  ),

  asyncHandler(
    async (
      req,
      res,
    ) => {
      const q =
        z.object({
          search:
            z.string()
              .trim()
              .max(200)
              .optional(),

          wardId:
            z.coerce
              .number()
              .int()
              .positive()
              .optional(),

          publicFacility:
            z.enum([
              'true',
              'false',
            ])
              .optional(),

          latitude:
            z.coerce
              .number()
              .min(-90)
              .max(90)
              .optional(),

          longitude:
            z.coerce
              .number()
              .min(-180)
              .max(180)
              .optional(),

          radiusMeters:
            z.coerce
              .number()
              .min(1)
              .max(5000)
              .default(250),

          page:
            z.coerce
              .number()
              .int()
              .min(1)
              .default(1),

          limit:
            z.coerce
              .number()
              .int()
              .min(1)
              .max(100)
              .default(25),
        })
          .parse(
            req.query,
          )

      const where:
        string[] = [
          'b.deleted_at IS NULL',
          'b.active = 1',
        ]

      const params:
        any[] = []

      /* =====================================================
         TEXT SEARCH
      ===================================================== */

      if (
        q.search
      ) {
        const like =
          `%${q.search}%`

        where.push(
          `
          (
            b.building_code LIKE ?

            OR b.external_feature_id LIKE ?

            OR b.name LIKE ?

            OR b.resolved_name LIKE ?

            OR b.address LIKE ?

            OR CAST(b.latitude AS CHAR) LIKE ?

            OR CAST(b.longitude AS CHAR) LIKE ?

            OR EXISTS (
              SELECT 1
              FROM building_aliases ba
              WHERE ba.building_id = b.id
                AND ba.name LIKE ?
            )
          )
          `,
        )

        params.push(
          like,
          like,
          like,
          like,
          like,
          like,
          like,
          like,
        )
      }

      /* =====================================================
         WARD
      ===================================================== */

      if (
        q.wardId
      ) {
        where.push(
          'b.ward_id = ?',
        )

        params.push(
          q.wardId,
        )
      }

      /* =====================================================
         PUBLIC FACILITY
      ===================================================== */

      if (
        q.publicFacility !==
        undefined
      ) {
        where.push(
          'b.public_facility = ?',
        )

        params.push(
          q.publicFacility ===
          'true'
            ? 1
            : 0,
        )
      }

      /* =====================================================
         COORDINATE SEARCH

         Uses Haversine distance.

         Both latitude and longitude must be supplied.
      ===================================================== */

      const hasCoordinates =
        q.latitude !==
          undefined &&
        q.longitude !==
          undefined

      let distanceSql =
        'NULL AS distanceMeters'

      if (
        hasCoordinates
      ) {
        /*
          MySQL Haversine distance in metres.
        */
        const distanceExpression =
          `
          (
            6371000 *
            2 *
            ASIN(
              SQRT(
                POWER(
                  SIN(
                    RADIANS(
                      b.latitude - ?
                    ) / 2
                  ),
                  2
                )
                +
                COS(
                  RADIANS(?)
                )
                *
                COS(
                  RADIANS(
                    b.latitude
                  )
                )
                *
                POWER(
                  SIN(
                    RADIANS(
                      b.longitude - ?
                    ) / 2
                  ),
                  2
                )
              )
            )
          )
          `

        /*
          These params belong to SELECT.
        */
        distanceSql =
          `${distanceExpression} AS distanceMeters`

        /*
          Radius filter repeats the same expression.
        */
        where.push(
          `${distanceExpression} <= ?`,
        )

        /*
          We need SELECT parameters first and WHERE parameters
          afterwards, so use separate lists below.
        */
      }

      const offset =
        (
          q.page -
          1
        ) *
        q.limit

      const selectParams:
        any[] =
        []

      const whereParams =
        [
          ...params,
        ]

      if (
        hasCoordinates
      ) {
        selectParams.push(
          q.latitude,
          q.latitude,
          q.longitude,
        )

        whereParams.push(
          q.latitude,
          q.latitude,
          q.longitude,
          q.radiusMeters,
        )
      }

      /* =====================================================
         DATA QUERY
      ===================================================== */

      const orderBy =
        hasCoordinates
          ? `
              distanceMeters ASC,
              COALESCE(
                b.resolved_name,
                b.name,
                b.building_code
              )
            `
          : `
              COALESCE(
                b.resolved_name,
                b.name,
                b.building_code
              )
            `

      const [
        rows,
      ] =
        await pool.execute<
          RowDataPacket[]
        >(
          `
          SELECT
            b.building_code
              AS buildingCode,

            b.external_source
              AS externalSource,

            b.external_feature_id
              AS externalFeatureId,

            b.name,

            b.resolved_name
              AS resolvedName,

            b.address,

            b.building_type
              AS buildingType,

            b.public_facility
              AS publicFacility,

            b.latitude,

            b.longitude,

            b.name_match_status
              AS nameMatchStatus,

            b.osm_type
              AS osmType,

            b.osm_id
              AS osmId,

            w.id
              AS wardId,

            w.name
              AS wardName,

            (
              SELECT COUNT(*)
              FROM service_requests sr
              WHERE
                sr.building_id = b.id
                AND sr.deleted_at IS NULL
            )
              AS requestCount,

            ${distanceSql},

            b.updated_at
              AS updatedAt

          FROM buildings b

          LEFT JOIN wards w
            ON w.id =
               b.ward_id

          WHERE
            ${where.join(
              ' AND ',
            )}

          ORDER BY
            ${orderBy}

          LIMIT ?
          OFFSET ?
          `,
          [
            ...selectParams,
            ...whereParams,

            q.limit,
            offset,
          ],
        )

      /* =====================================================
         COUNT QUERY
      ===================================================== */

      const countParams =
        [
          ...params,
        ]

      if (
        hasCoordinates
      ) {
        /*
          Count query contains distance only inside WHERE,
          therefore only one coordinate parameter set.
        */
        countParams.push(
          q.latitude,
          q.latitude,
          q.longitude,
          q.radiusMeters,
        )
      }

      const [
        counts,
      ] =
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
            COUNT(*)
              AS total

          FROM buildings b

          WHERE
            ${where.join(
              ' AND ',
            )}
          `,
          countParams,
        )

      return ok(
        res,
        rows,
        {
          page:
            q.page,

          limit:
            q.limit,

          total:
            counts[0]
              ?.total ??
            0,
        },
      )
    },
  ),
)

/* =========================================================
   GET BUILDING
========================================================= */

router.get(
  '/:code',

  requirePermission(
    'building.sensitive.read',
  ),

  asyncHandler(
    async (
      req,
      res,
    ) => {
      const code =
        routeParam(
          req.params.code,
          'code',
        )

      const [
        rows,
      ] =
        await pool.execute<
          RowDataPacket[]
        >(
          `
          SELECT
            b.*,
            w.name
              AS ward_name

          FROM buildings b

          LEFT JOIN wards w
            ON w.id =
               b.ward_id

          WHERE
            b.building_code = ?
            AND b.deleted_at IS NULL

          LIMIT 1
          `,
          [
            code,
          ],
        )

      if (
        !rows[0]
      ) {
        throw notFound(
          'Building not found.',
        )
      }

      const [
        aliases,
      ] =
        await pool.execute<
          RowDataPacket[]
        >(
          `
          SELECT
            id,
            name,
            source,
            confidence,
            is_primary
              AS isPrimary,
            created_at
              AS createdAt

          FROM building_aliases

          WHERE
            building_id = ?

          ORDER BY
            is_primary DESC,
            name
          `,
          [
            (
              rows[0] as any
            ).id,
          ],
        )

      return ok(
        res,
        {
          ...rows[0],
          aliases,
        },
      )
    },
  ),
)

/* =========================================================
   UPDATE BUILDING
========================================================= */

router.patch(
  '/:code',

  requirePermission(
    'building.manage',
  ),

  asyncHandler(
    async (
      req,
      res,
    ) => {
      const code =
        routeParam(
          req.params.code,
          'code',
        )

      const input =
        z.object({
          name:
            z.string()
              .trim()
              .max(255)
              .nullable()
              .optional(),

          resolvedName:
            z.string()
              .trim()
              .max(255)
              .nullable()
              .optional(),

          address:
            z.string()
              .trim()
              .max(500)
              .nullable()
              .optional(),

          buildingType:
            z.string()
              .trim()
              .max(100)
              .nullable()
              .optional(),

          publicFacility:
            z.boolean()
              .optional(),

          wardId:
            z.number()
              .int()
              .positive()
              .nullable()
              .optional(),

          active:
            z.boolean()
              .optional(),
        })
          .parse(
            req.body,
          )

      const [
        currentRows,
      ] =
        await pool.execute<
          RowDataPacket[]
        >(
          `
          SELECT *
          FROM buildings
          WHERE
            building_code = ?
            AND deleted_at IS NULL
          LIMIT 1
          `,
          [
            code,
          ],
        )

      const current =
        currentRows[0] as any

      if (
        !current
      ) {
        throw notFound(
          'Building not found.',
        )
      }

      const sets:
        string[] = []

      const params:
        any[] = []

      const add =
        (
          column:
            string,

          value:
            unknown,
        ) => {
          sets.push(
            `${column} = ?`,
          )

          params.push(
            value,
          )
        }

      if (
        input.name !==
        undefined
      ) {
        add(
          'name',
          input.name,
        )
      }

      if (
        input.resolvedName !==
        undefined
      ) {
        add(
          'resolved_name',
          input.resolvedName,
        )
      }

      if (
        input.address !==
        undefined
      ) {
        add(
          'address',
          input.address,
        )
      }

      if (
        input.buildingType !==
        undefined
      ) {
        add(
          'building_type',
          input.buildingType,
        )
      }

      if (
        input.publicFacility !==
        undefined
      ) {
        add(
          'public_facility',
          input.publicFacility
            ? 1
            : 0,
        )
      }

      if (
        input.wardId !==
        undefined
      ) {
        add(
          'ward_id',
          input.wardId,
        )
      }

      if (
        input.active !==
        undefined
      ) {
        add(
          'active',
          input.active
            ? 1
            : 0,
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
        UPDATE buildings

        SET
          ${sets.join(
            ', ',
          )}

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
            'BUILDING_UPDATED',

          entityType:
            'BUILDING',

          entityId:
            code,

          beforeData: {
            name:
              current.name,

            resolvedName:
              current.resolved_name,

            address:
              current.address,

            publicFacility:
              current.public_facility,
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
   ADD ALIAS
========================================================= */

router.post(
  '/:code/aliases',

  requirePermission(
    'building.manage',
  ),

  asyncHandler(
    async (
      req,
      res,
    ) => {
      const code =
        routeParam(
          req.params.code,
          'code',
        )

      const input =
        z.object({
          name:
            z.string()
              .trim()
              .min(1)
              .max(255),

          source:
            z.string()
              .trim()
              .min(1)
              .max(50)
              .default(
                'MANUAL',
              ),

          confidence:
            z.string()
              .trim()
              .max(40)
              .nullable()
              .optional(),

          isPrimary:
            z.boolean()
              .default(
                false,
              ),
        })
          .parse(
            req.body,
          )

      const [
        buildings,
      ] =
        await pool.execute<
          (
            RowDataPacket & {
              id:
                number
            }
          )[]
        >(
          `
          SELECT id
          FROM buildings
          WHERE
            building_code = ?
            AND deleted_at IS NULL
          LIMIT 1
          `,
          [
            code,
          ],
        )

      if (
        !buildings[0]
      ) {
        throw notFound(
          'Building not found.',
        )
      }

      if (
        input.isPrimary
      ) {
        await pool.execute(
          `
          UPDATE building_aliases
          SET
            is_primary = 0
          WHERE
            building_id = ?
          `,
          [
            buildings[0]
              .id,
          ],
        )
      }

      const [
        result,
      ] =
        await pool.execute<
          ResultSetHeader
        >(
          `
          INSERT INTO building_aliases (
            building_id,
            name,
            source,
            confidence,
            is_primary,
            created_at
          )
          VALUES (
            ?,
            ?,
            ?,
            ?,
            ?,
            UTC_TIMESTAMP()
          )
          `,
          [
            buildings[0]
              .id,

            input.name,

            input.source,

            input.confidence ??
              null,

            input.isPrimary
              ? 1
              : 0,
          ],
        )

      if (
        input.isPrimary
      ) {
        await pool.execute(
          `
          UPDATE buildings
          SET
            resolved_name = ?,
            name_match_status = 'MANUAL_VERIFIED',
            updated_at = UTC_TIMESTAMP()
          WHERE
            id = ?
          `,
          [
            input.name,
            buildings[0]
              .id,
          ],
        )
      }

      await writeAudit(
        {
          actorUserId:
            req.authUser!.id,

          action:
            'BUILDING_ALIAS_ADDED',

          entityType:
            'BUILDING',

          entityId:
            code,

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

      return created(
        res,
        {
          id:
            result.insertId,
        },
      )
    },
  ),
)

export default router