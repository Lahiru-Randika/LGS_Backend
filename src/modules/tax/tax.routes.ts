import { Router } from 'express'
import type { RowDataPacket } from 'mysql2/promise'
import { z } from 'zod'

import { pool } from '../../config/db'
import { authenticate } from '../../middleware/authenticate'
import { requirePermission } from '../../middleware/authorize'
import { writeAudit } from '../../services/audit.service'
import { asyncHandler } from '../../utils/asyncHandler'
import { notFound } from '../../utils/errors'
import { ok } from '../../utils/http'
import { routeParam } from '../../utils/routeParam'

const router = Router()

router.use(
  authenticate,
  requirePermission('tax.read'),
)

/* =========================================================
   TAX SUMMARY
========================================================= */

router.get(
  '/summary',
  asyncHandler(async (req, res) => {
    const q = z
      .object({
        year: z.coerce
          .number()
          .int()
          .min(2000)
          .max(2100)
          .default(
            new Date().getUTCFullYear(),
          ),
      })
      .parse(req.query)

    const [rows] =
      await pool.execute<
        RowDataPacket[]
      >(
        `
        SELECT
          COALESCE(
            SUM(ta.assessed_amount),
            0
          ) AS annualTarget,

          COALESCE(
            SUM(tp.amount),
            0
          ) AS collected,

          COALESCE(
            SUM(ta.amount_due),
            0
          ) AS outstanding

        FROM tax_assessments ta

        LEFT JOIN tax_payments tp
          ON tp.tax_assessment_id = ta.id

        WHERE
          ta.tax_year = ?
        `,
        [
          q.year,
        ],
      )

    const row:
      any =
      rows[0] ??
      {}

    const target =
      Number(
        row.annualTarget ||
        0,
      )

    const collected =
      Number(
        row.collected ||
        0,
      )

    await writeAudit({
      actorUserId:
        req.authUser!.id,

      action:
        'TAX_SUMMARY_VIEWED',

      entityType:
        'TAX',

      entityId:
        String(
          q.year,
        ),

      ipAddress:
        req.ip,

      userAgent:
        req.get(
          'user-agent',
        ),

      requestId:
        req.requestId,
    })

    return ok(
      res,
      {
        year:
          q.year,

        annualTarget:
          target,

        collected,

        outstanding:
          Number(
            row.outstanding ||
            0,
          ),

        collectionRate:
          target >
          0
            ? Number(
                (
                  (
                    collected /
                    target
                  ) *
                  100
                ).toFixed(
                  2,
                ),
              )
            : 0,
      },
    )
  }),
)

/* =========================================================
   MONTHLY COLLECTION
========================================================= */

router.get(
  '/monthly',
  asyncHandler(async (req, res) => {
    const q = z
      .object({
        year: z.coerce
          .number()
          .int()
          .min(2000)
          .max(2100)
          .default(
            new Date().getUTCFullYear(),
          ),
      })
      .parse(req.query)

    const [rows] =
      await pool.execute<
        RowDataPacket[]
      >(
        `
        SELECT
          DATE_FORMAT(
            tp.paid_at,
            '%Y-%m'
          ) AS month,

          SUM(
            tp.amount
          ) AS collected

        FROM tax_payments tp

        JOIN tax_assessments ta
          ON ta.id =
             tp.tax_assessment_id

        WHERE
          ta.tax_year = ?

        GROUP BY
          DATE_FORMAT(
            tp.paid_at,
            '%Y-%m'
          )

        ORDER BY
          month
        `,
        [
          q.year,
        ],
      )

    return ok(
      res,
      rows,
    )
  }),
)

/* =========================================================
   COLLECTION BY WARD
========================================================= */

router.get(
  '/by-ward',
  asyncHandler(async (req, res) => {
    const q = z
      .object({
        year: z.coerce
          .number()
          .int()
          .min(2000)
          .max(2100)
          .default(
            new Date().getUTCFullYear(),
          ),
      })
      .parse(req.query)

    const [rows] =
      await pool.execute<
        RowDataPacket[]
      >(
        `
        SELECT
          w.id AS wardId,
          w.name AS wardName,

          SUM(
            ta.assessed_amount
          ) AS assessed,

          SUM(
            ta.amount_due
          ) AS outstanding

        FROM tax_assessments ta

        JOIN tax_accounts tc
          ON tc.id =
             ta.tax_account_id

        JOIN properties p
          ON p.id =
             tc.property_id

        JOIN buildings b
          ON b.id =
             p.building_id

        LEFT JOIN wards w
          ON w.id =
             b.ward_id

        WHERE
          ta.tax_year = ?

        GROUP BY
          w.id,
          w.name

        ORDER BY
          w.name
        `,
        [
          q.year,
        ],
      )

    return ok(
      res,
      rows,
    )
  }),
)

/* =========================================================
   PROPERTY TAX DETAILS

   GET /properties/:buildingCode
========================================================= */

router.get(
  '/properties/:buildingCode',
  asyncHandler(async (req, res) => {
    /*
      FIX:
      Express route params may be typed as:
        string | string[]

      Resolve it once to a guaranteed string.
    */
    const buildingCode =
      routeParam(
        req.params.buildingCode,
        'buildingCode',
      )

    const [rows] =
      await pool.execute<
        RowDataPacket[]
      >(
        `
        SELECT
          b.building_code AS buildingCode,

          COALESCE(
            b.resolved_name,
            b.name
          ) AS buildingName,

          p.property_code AS propertyCode,

          p.assessment_value AS assessmentValue,

          p.valuation_date AS valuationDate,

          tc.tax_code AS taxCode,

          tc.status AS taxStatus,

          tc.current_balance AS currentBalance

        FROM buildings b

        JOIN properties p
          ON p.building_id =
             b.id

        JOIN tax_accounts tc
          ON tc.property_id =
             p.id

        WHERE
          b.building_code = ?
          AND b.deleted_at IS NULL

        LIMIT 1
        `,
        [
          buildingCode,
        ],
      )

    if (
      !rows[0]
    ) {
      throw notFound(
        'Tax/property record not found.',
      )
    }

    await writeAudit({
      actorUserId:
        req.authUser!.id,

      action:
        'TAX_PROPERTY_VIEWED',

      entityType:
        'BUILDING',

      /*
        FIX:
        Use the resolved string value instead of req.params.buildingCode.
      */
      entityId:
        buildingCode,

      ipAddress:
        req.ip,

      userAgent:
        req.get(
          'user-agent',
        ),

      requestId:
        req.requestId,
    })

    return ok(
      res,
      rows[0],
    )
  }),
)

export default router
