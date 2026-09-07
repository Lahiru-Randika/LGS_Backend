import crypto from 'node:crypto'

import {
  Router,
} from 'express'

import type {
  PoolConnection,
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
  asyncHandler,
} from '../../utils/asyncHandler'

import {
  ok,
} from '../../utils/http'

const router =
  Router()

router.use(
  authenticate,
)

/* =========================================================
   TYPES
========================================================= */

type BuildingRow =
  RowDataPacket & {
    id:
      number

    buildingCode:
      string

    externalFeatureId:
      string | null

    name:
      string | null

    resolvedName:
      string | null

    address:
      string | null

    buildingType:
      string | null

    latitude:
      number | string | null

    longitude:
      number | string | null

    geometryJson:
      unknown

    nameMatchStatus:
      string | null
  }

type ResolutionInput = {
  name:
    string

  address?:
    string | null

  buildingType?:
    string | null
}

/* =========================================================
   STRING HELPERS
========================================================= */

function text(
  value:
    unknown,

  maxLength:
    number,
) {
  if (
    value ===
      undefined ||
    value ===
      null
  ) {
    return null
  }

  const result =
    String(
      value,
    ).trim()

  if (
    !result
  ) {
    return null
  }

  return result.slice(
    0,
    maxLength,
  )
}

/* =========================================================
   GEOMETRY HASH

   IMPORTANT:
   This is the same hash principle we used in the CMC sync.

   DB:
   1-9a7284164629
   1-e0041bf2450c
========================================================= */

function geometryHash(
  geometry:
    unknown,
) {
  return crypto
    .createHash(
      'sha256',
    )
    .update(
      JSON.stringify(
        geometry,
      ),
    )
    .digest(
      'hex',
    )
    .slice(
      0,
      12,
    )
}

/* =========================================================
   GEOJSON PARSER
========================================================= */

function parseGeometry(
  value:
    unknown,
):
  any | null {
  if (
    !value
  ) {
    return null
  }

  if (
    typeof value ===
      'string'
  ) {
    try {
      return JSON.parse(
        value,
      )
    } catch {
      return null
    }
  }

  if (
    typeof value ===
      'object'
  ) {
    return value
  }

  return null
}

/* =========================================================
   POINT IN RING

   GeoJSON coordinate order:

   [longitude, latitude]
========================================================= */

function pointInRing(
  longitude:
    number,

  latitude:
    number,

  ring:
    number[][],
) {
  let inside =
    false

  for (
    let i =
        0,
      j =
        ring.length -
        1;

    i <
    ring.length;

    j =
      i++
  ) {
    const xi =
      Number(
        ring[i]?.[
          0
        ],
      )

    const yi =
      Number(
        ring[i]?.[
          1
        ],
      )

    const xj =
      Number(
        ring[j]?.[
          0
        ],
      )

    const yj =
      Number(
        ring[j]?.[
          1
        ],
      )

    if (
      !Number.isFinite(
        xi,
      ) ||
      !Number.isFinite(
        yi,
      ) ||
      !Number.isFinite(
        xj,
      ) ||
      !Number.isFinite(
        yj,
      )
    ) {
      continue
    }

    const intersect =
      (
        yi >
        latitude
      ) !==
        (
          yj >
          latitude
        ) &&
      longitude <
        (
          (
            xj -
            xi
          ) *
            (
              latitude -
              yi
            )
        ) /
          (
            yj -
              yi ||
            Number.EPSILON
          ) +
          xi

    if (
      intersect
    ) {
      inside =
        !inside
    }
  }

  return inside
}

/* =========================================================
   POINT IN POLYGON

   Handles holes.
========================================================= */

function pointInPolygon(
  longitude:
    number,

  latitude:
    number,

  polygon:
    number[][][],
) {
  if (
    !polygon.length
  ) {
    return false
  }

  /*
    Must be inside exterior ring.
  */
  if (
    !pointInRing(
      longitude,
      latitude,
      polygon[0],
    )
  ) {
    return false
  }

  /*
    Must NOT be inside a hole.
  */
  for (
    let index =
      1;

    index <
    polygon.length;

    index++
  ) {
    if (
      pointInRing(
        longitude,
        latitude,
        polygon[index],
      )
    ) {
      return false
    }
  }

  return true
}

/* =========================================================
   POINT IN GEOJSON GEOMETRY
========================================================= */

function geometryContainsPoint(
  geometry:
    any,

  longitude:
    number,

  latitude:
    number,
) {
  if (
    geometry?.type ===
    'Polygon'
  ) {
    return pointInPolygon(
      longitude,
      latitude,
      geometry.coordinates,
    )
  }

  if (
    geometry?.type ===
    'MultiPolygon'
  ) {
    return geometry.coordinates.some(
      (
        polygon:
          number[][][],
      ) =>
        pointInPolygon(
          longitude,
          latitude,
          polygon,
        ),
    )
  }

  return false
}

/* =========================================================
   SELECT BUILDING
========================================================= */

const buildingSelect =
  `
  SELECT
    b.id,

    b.building_code
      AS buildingCode,

    b.external_feature_id
      AS externalFeatureId,

    b.name,

    b.resolved_name
      AS resolvedName,

    b.address,

    b.building_type
      AS buildingType,

    b.latitude,

    b.longitude,

    b.geometry_json
      AS geometryJson,

    b.name_match_status
      AS nameMatchStatus

  FROM buildings b
  `

/* =========================================================
   FIND BY HASHED CMC FEATURE
========================================================= */

async function findByGeometry(
  connection:
    PoolConnection,

  rawFeatureId:
    string | null,

  geometry:
    unknown,
) {
  const hash =
    geometryHash(
      geometry,
    )

  /*
    Best match:
    same exact raw CMC ID + geometry hash.
  */
  if (
    rawFeatureId
  ) {
    const externalId =
      `${rawFeatureId}-${hash}`

    const [
      rows,
    ] =
      await connection.execute<
        BuildingRow[]
      >(
        `
        ${buildingSelect}

        WHERE
          b.external_source = 'CMC_VISIGEO'
          AND b.external_feature_id = ?
          AND b.deleted_at IS NULL
          AND b.active = 1

        LIMIT 1
        `,
        [
          externalId,
        ],
      )

    if (
      rows[0]
    ) {
      return rows[0]
    }
  }

  /*
    Fallback:
    match by geometry hash suffix.

    Useful for features where CMC provided no usable raw ID.
  */
  const [
    suffixRows,
  ] =
    await connection.execute<
      BuildingRow[]
    >(
      `
      ${buildingSelect}

      WHERE
        b.external_source = 'CMC_VISIGEO'
        AND b.external_feature_id LIKE ?
        AND b.deleted_at IS NULL
        AND b.active = 1

      LIMIT 2
      `,
      [
        `%-${hash}`,
      ],
    )

  if (
    suffixRows.length ===
    1
  ) {
    return suffixRows[0]
  }

  return null
}

/* =========================================================
   FIND BUILDING CONTAINING OSM POINT

   We first use a small coordinate bounding box so we don't
   parse all 442 polygons every time.
========================================================= */

async function findContainingBuilding(
  connection:
    PoolConnection,

  latitude:
    number,

  longitude:
    number,
) {
  /*
    About ~300 metres around Colombo.

    This is only a DB pre-filter.
    Actual matching below uses polygon containment.
  */
  const delta =
    0.003

  const [
    rows,
  ] =
    await connection.execute<
      BuildingRow[]
    >(
      `
      ${buildingSelect}

      WHERE
        b.external_source = 'CMC_VISIGEO'

        AND b.deleted_at IS NULL

        AND b.active = 1

        AND b.latitude
          BETWEEN ?
          AND ?

        AND b.longitude
          BETWEEN ?
          AND ?
      `,
      [
        latitude -
          delta,

        latitude +
          delta,

        longitude -
          delta,

        longitude +
          delta,
      ],
    )

  for (
    const building of rows
  ) {
    const geometry =
      parseGeometry(
        building.geometryJson,
      )

    if (
      geometry &&
      geometryContainsPoint(
        geometry,
        longitude,
        latitude,
      )
    ) {
      return building
    }
  }

  return null
}

/* =========================================================
   READ ONE BUILDING AFTER SAVE
========================================================= */

async function readBuilding(
  connection:
    PoolConnection,

  id:
    number,
) {
  const [
    rows,
  ] =
    await connection.execute<
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

        COALESCE(
          b.resolved_name,
          b.name,
          b.building_code
        )
          AS name,

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

        (
          SELECT
            COUNT(*)

          FROM service_requests sr

          WHERE
            sr.building_id =
              b.id

            AND sr.deleted_at
              IS NULL
        )
          AS requestCount

      FROM buildings b

      WHERE
        b.id = ?

      LIMIT 1
      `,
      [
        id,
      ],
    )

  return rows[0] ??
    null
}

/* =========================================================
   SAVE VERIFIED RESOLUTION
========================================================= */

async function saveResolution(
  connection:
    PoolConnection,

  building:
    BuildingRow,

  input:
    ResolutionInput,
) {
  const name =
    text(
      input.name,
      255,
    )

  const address =
    text(
      input.address,
      500,
    )

  const buildingType =
    text(
      input.buildingType,
      100,
    )

  if (
    !name
  ) {
    throw new Error(
      'Resolved building name is required.',
    )
  }

  /*
    Never automatically overwrite an administrator's
    manually verified record.
  */
  if (
    building.nameMatchStatus ===
    'MANUAL_VERIFIED'
  ) {
    return readBuilding(
      connection,
      building.id,
    )
  }

  await connection.execute(
    `
    UPDATE buildings

    SET
      resolved_name = ?,

      address =
        COALESCE(
          ?,
          address
        ),

      building_type =
        COALESCE(
          ?,
          building_type
        ),

      name_match_status =
        'POLYGON_VERIFIED',

      updated_at =
        UTC_TIMESTAMP()

    WHERE
      id = ?
    `,
    [
      name,
      address,
      buildingType,
      building.id,
    ],
  )

  /* =====================================================
     ALIAS CACHE

     Example:
     Nelum Pokuna Mahinda Rajapaksa Theatre
  ===================================================== */

  const [
    existingAlias,
  ] =
    await connection.execute<
      RowDataPacket[]
    >(
      `
      SELECT id

      FROM building_aliases

      WHERE
        building_id = ?

        AND LOWER(name) =
            LOWER(?)

      LIMIT 1
      `,
      [
        building.id,
        name,
      ],
    )

  if (
    !existingAlias[0]
  ) {
    const [
      primaryRows,
    ] =
      await connection.execute<
        RowDataPacket[]
      >(
        `
        SELECT id

        FROM building_aliases

        WHERE
          building_id = ?
          AND is_primary = 1

        LIMIT 1
        `,
        [
          building.id,
        ],
      )

    await connection.execute(
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
        'OSM',
        'POLYGON_MATCH',
        ?,
        UTC_TIMESTAMP()
      )
      `,
      [
        building.id,
        name,

        primaryRows[0]
          ? 0
          : 1,
      ],
    )
  }

  return readBuilding(
    connection,
    building.id,
  )
}

/* =========================================================
   1. CACHE RESULT FROM EXISTING MAP RESOLVER

   POST
   /api/v1/map/buildings/cache-resolution

   Called AFTER existing frontend resolver already obtained:

   confidence = polygon-match
========================================================= */

router.post(
  '/buildings/cache-resolution',

  requirePermission(
    'building.sensitive.read',
  ),

  asyncHandler(
    async (
      req,
      res,
    ) => {
      const input =
        z.object({
          rawFeatureId:
            z.string()
              .trim()
              .max(150)
              .nullable()
              .optional(),

          geometry:
            z.any(),

          latitude:
            z.coerce
              .number()
              .min(-90)
              .max(90),

          longitude:
            z.coerce
              .number()
              .min(-180)
              .max(180),

          name:
            z.string()
              .trim()
              .min(1)
              .max(255),

          address:
            z.string()
              .trim()
              .max(500)
              .nullable()
              .optional(),

          buildingType:
            z.string()
              .trim()
              .max(200)
              .nullable()
              .optional(),
        })
          .parse(
            req.body,
          )

      const connection =
        await pool.getConnection()

      try {
        await connection.beginTransaction()

        /*
          First try exact hashed CMC feature.
        */
        let building =
          await findByGeometry(
            connection,
            input.rawFeatureId ??
              null,
            input.geometry,
          )

        /*
          Safety fallback:
          use the clicked polygon centre and find the polygon
          actually containing that point.
        */
        if (
          !building
        ) {
          building =
            await findContainingBuilding(
              connection,
              input.latitude,
              input.longitude,
            )
        }

        if (
          !building
        ) {
          await connection.rollback()

          return ok(
            res,
            {
              matched:
                false,
            },
          )
        }

        const saved =
          await saveResolution(
            connection,
            building,
            {
              name:
                input.name,

              address:
                input.address,

              buildingType:
                input.buildingType,
            },
          )

        await connection.commit()

        return ok(
          res,
          {
            matched:
              true,

            building:
              saved,
          },
        )
      } catch (
        error
      ) {
        await connection.rollback()

        throw error
      } finally {
        connection.release()
      }
    },
  ),
)

/* =========================================================
   2. MATCH AN OSM SEARCH RESULT TO CMC BUILDING

   POST
   /api/v1/map/buildings/match-place

   Used by BuildingsPage when:
   local DB search returned 0 results.

   The backend itself verifies:
   "Is this OSM point actually inside a CMC polygon?"
========================================================= */

router.post(
  '/buildings/match-place',

  requirePermission(
    'building.sensitive.read',
  ),

  asyncHandler(
    async (
      req,
      res,
    ) => {
      const input =
        z.object({
          latitude:
            z.coerce
              .number()
              .min(-90)
              .max(90),

          longitude:
            z.coerce
              .number()
              .min(-180)
              .max(180),

          name:
            z.string()
              .trim()
              .min(1)
              .max(255),

          address:
            z.string()
              .trim()
              .max(500)
              .nullable()
              .optional(),

          buildingType:
            z.string()
              .trim()
              .max(200)
              .nullable()
              .optional(),
        })
          .parse(
            req.body,
          )

      const connection =
        await pool.getConnection()

      try {
        await connection.beginTransaction()

        const building =
          await findContainingBuilding(
            connection,
            input.latitude,
            input.longitude,
          )

        /*
          IMPORTANT:
          We do NOT blindly assign the nearest building.

          If the OSM point is not inside a CMC polygon,
          it is not considered polygon verified.
        */
        if (
          !building
        ) {
          await connection.rollback()

          return ok(
            res,
            {
              matched:
                false,
            },
          )
        }

        const saved =
          await saveResolution(
            connection,
            building,
            {
              name:
                input.name,

              address:
                input.address,

              buildingType:
                input.buildingType,
            },
          )

        await connection.commit()

        return ok(
          res,
          {
            matched:
              true,

            building:
              saved,
          },
        )
      } catch (
        error
      ) {
        await connection.rollback()

        throw error
      } finally {
        connection.release()
      }
    },
  ),
)

export default router