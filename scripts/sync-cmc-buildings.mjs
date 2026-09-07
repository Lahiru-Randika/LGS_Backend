import 'dotenv/config'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import mysql from 'mysql2/promise'

/* =========================================================
   COMMAND LINE

   Dry run:

   node scripts/sync-cmc-buildings.mjs

   Actual import:

   node scripts/sync-cmc-buildings.mjs --write

   Custom source:

   node scripts/sync-cmc-buildings.mjs --url http://localhost:5173/cmc/vector/buildings.geojson --write
========================================================= */

const args =
  process.argv.slice(
    2,
  )

const WRITE =
  args.includes(
    '--write',
  )

const urlIndex =
  args.indexOf(
    '--url',
  )

const SOURCE_URL =
  urlIndex >= 0 &&
  args[
    urlIndex + 1
  ]
    ? args[
        urlIndex + 1
      ]
    : process.env
        .CMC_BUILDINGS_URL ||
      'http://localhost:5173/cmc/vector/buildings.geojson'

const EXTERNAL_SOURCE =
  'CMC_VISIGEO'

/* =========================================================
   TERMINAL HELPERS
========================================================= */

function section(
  title,
) {
  console.log(
    '\n============================================================',
  )

  console.log(
    title,
  )

  console.log(
    '============================================================',
  )
}

function valueFrom(
  properties,
  keys,
) {
  for (
    const key of keys
  ) {
    const value =
      properties?.[
        key
      ]

    if (
      value !==
        undefined &&
      value !==
        null &&
      String(
        value,
      ).trim()
    ) {
      return String(
        value,
      ).trim()
    }
  }

  return null
}

/* =========================================================
   FEATURE ID
========================================================= */

function featureId(
  feature,
  index,
) {
  const properties =
    feature?.properties ||
    {}

  const rawId =
    valueFrom(
      properties,
      [
        'id',
        'ID',
        'Id',
        'fid',
        'FID',
        'OBJECTID',
        'ObjectID',
        'objectid',
        'building_id',
        'buildingid',
      ],
    ) ??
    (
      feature?.id !==
      undefined &&
      feature?.id !==
      null
        ? String(
            feature.id,
          )
        : `feature-${index + 1}`
    )

  /*
    Geometry hash makes the external ID unique
    even when the CMC dataset reuses IDs such as "1".
  */
  const geometryHash =
    crypto
      .createHash(
        'sha256',
      )
      .update(
        JSON.stringify(
          feature.geometry,
        ),
      )
      .digest(
        'hex',
      )
      .slice(
        0,
        12,
      )

  return `${rawId}-${geometryHash}`
}

/* =========================================================
   NAME
========================================================= */

function featureName(
  properties,
) {
  return valueFrom(
    properties,
    [
      'name',
      'Name',
      'NAME',

      'building_name',
      'Building_Name',

      'building',
      'Building',

      'premises',
      'Premises',

      'facility_name',
      'Facility_Name',

      'facility',
      'Facility',
    ],
  )
}

/* =========================================================
   ADDRESS
========================================================= */

function featureAddress(
  properties,
) {
  return valueFrom(
    properties,
    [
      'address',
      'Address',
      'ADDRESS',

      'street',
      'Street',

      'location',
      'Location',

      'road',
      'Road',

      'road_name',
      'Road_Name',
    ],
  )
}

/* =========================================================
   TYPE
========================================================= */

function featureType(
  properties,
) {
  return valueFrom(
    properties,
    [
      'type',
      'Type',

      'building_type',
      'Building_Type',

      'category',
      'Category',

      'use',
      'Use',
    ],
  )
}

/* =========================================================
   COORDINATES

   Walk through Polygon / MultiPolygon coordinates.
========================================================= */

function collectCoordinates(
  value,
  output,
) {
  if (
    !Array.isArray(
      value,
    )
  ) {
    return
  }

  /*
    Leaf coordinate:

    [longitude, latitude]
  */
  if (
    value.length >=
      2 &&
    typeof value[0] ===
      'number' &&
    typeof value[1] ===
      'number'
  ) {
    output.push(
      [
        Number(
          value[0],
        ),

        Number(
          value[1],
        ),
      ],
    )

    return
  }

  for (
    const child of value
  ) {
    collectCoordinates(
      child,
      output,
    )
  }
}

/* =========================================================
   BUILDING CENTER

   Uses bounding-box centre.

   That is perfectly adequate for locating/searching
   the municipal building record.
========================================================= */

function geometryCenter(
  geometry,
) {
  if (
    !geometry?.coordinates
  ) {
    return null
  }

  const coordinates =
    []

  collectCoordinates(
    geometry.coordinates,
    coordinates,
  )

  if (
    !coordinates.length
  ) {
    return null
  }

  let minLongitude =
    Infinity

  let maxLongitude =
    -Infinity

  let minLatitude =
    Infinity

  let maxLatitude =
    -Infinity

  for (
    const [
      longitude,
      latitude,
    ] of coordinates
  ) {
    minLongitude =
      Math.min(
        minLongitude,
        longitude,
      )

    maxLongitude =
      Math.max(
        maxLongitude,
        longitude,
      )

    minLatitude =
      Math.min(
        minLatitude,
        latitude,
      )

    maxLatitude =
      Math.max(
        maxLatitude,
        latitude,
      )
  }

  const longitude =
    (
      minLongitude +
      maxLongitude
    ) /
    2

  const latitude =
    (
      minLatitude +
      maxLatitude
    ) /
    2

  if (
    !Number.isFinite(
      latitude,
    ) ||
    !Number.isFinite(
      longitude,
    )
  ) {
    return null
  }

  return {
    latitude:
      Number(
        latitude.toFixed(
          7,
        ),
      ),

    longitude:
      Number(
        longitude.toFixed(
          7,
        ),
      ),
  }
}

/* =========================================================
   WGS84 VALIDATION

   This prevents accidentally importing EPSG:5235
   coordinates such as:

   398990, 489521

   into latitude/longitude columns.
========================================================= */

function looksLikeSriLanka(
  point,
) {
  return (
    point.latitude >=
      5 &&
    point.latitude <=
      10 &&
    point.longitude >=
      79 &&
    point.longitude <=
      82
  )
}

/* =========================================================
   FETCH CMC GEOJSON
========================================================= */

async function loadGeoJson() {
  section(
    'CMC BUILDING SOURCE',
  )

  console.log(
    'Source:',
    SOURCE_URL,
  )

  console.log(
    'Mode:',
    WRITE
      ? 'WRITE TO DATABASE'
      : 'DRY RUN',
  )

  const response =
    await fetch(
      SOURCE_URL,
      {
        headers: {
          Accept:
            'application/geo+json, application/json',
        },
      },
    )

  if (
    !response.ok
  ) {
    throw new Error(
      `Unable to fetch CMC buildings. HTTP ${response.status} ${response.statusText}`,
    )
  }

  const text =
    await response.text()

  let data

  try {
    data =
      JSON.parse(
        text,
      )
  } catch {
    throw new Error(
      'CMC buildings response is not valid JSON. Check the --url value.',
    )
  }

  if (
    data?.type !==
      'FeatureCollection' ||
    !Array.isArray(
      data.features,
    )
  ) {
    throw new Error(
      'CMC source is not a valid GeoJSON FeatureCollection.',
    )
  }

  console.log(
    '✅ GeoJSON loaded.',
  )

  console.log(
    'Features:',
    data.features.length,
  )

  return data
}

/* =========================================================
   PREPARE BUILDINGS
========================================================= */

function prepareBuildings(
  geojson,
) {
  const prepared =
    []

  const skipped =
    []

  geojson.features.forEach(
    (
      feature,
      index,
    ) => {
      if (
        ![
          'Polygon',
          'MultiPolygon',
        ].includes(
          feature?.geometry
            ?.type,
        )
      ) {
        skipped.push(
          {
            index:
              index +
              1,

            reason:
              `Unsupported geometry: ${feature?.geometry?.type || 'none'}`,
          },
        )

        return
      }

      const center =
        geometryCenter(
          feature.geometry,
        )

      if (
        !center
      ) {
        skipped.push(
          {
            index:
              index +
              1,

            reason:
              'Unable to calculate coordinates',
          },
        )

        return
      }

      if (
        !looksLikeSriLanka(
          center,
        )
      ) {
        skipped.push(
          {
            index:
              index +
              1,

            reason:
              `Coordinates do not look like WGS84: ${center.latitude}, ${center.longitude}`,
          },
        )

        return
      }

      const properties =
        feature.properties ||
        {}

      prepared.push(
        {
          externalFeatureId:
            featureId(
              feature,
              index,
            ),

          name:
            featureName(
              properties,
            ),

          address:
            featureAddress(
              properties,
            ),

          buildingType:
            featureType(
              properties,
            ),

          latitude:
            center.latitude,

          longitude:
            center.longitude,

          geometryJson:
            JSON.stringify(
              feature.geometry,
            ),

          properties,
        },
      )
    },
  )

  section(
    'CMC VALIDATION',
  )

  console.log(
    'Valid buildings:',
    prepared.length,
  )

  console.log(
    'Skipped:',
    skipped.length,
  )

  if (
    skipped.length
  ) {
    console.log(
      '\nFirst skipped records:',
    )

    console.table(
      skipped.slice(
        0,
        10,
      ),
    )
  }

  return prepared
}

/* =========================================================
   DATABASE CONFIGURATION
========================================================= */

function databaseConfig() {
  const databaseUrl =
    process.env
      .DATABASE_URL

  if (
    !databaseUrl
  ) {
    throw new Error(
      'DATABASE_URL is missing from .env',
    )
  }

  const url =
    new URL(
      databaseUrl,
    )

  let ssl

  if (
    String(
      process.env
        .DB_SSL,
    ).toLowerCase() ===
    'true'
  ) {
    const caPath =
      process.env
        .DB_SSL_CA_PATH

    if (
      !caPath
    ) {
      throw new Error(
        'DB_SSL=true but DB_SSL_CA_PATH is missing.',
      )
    }

    const absoluteCaPath =
      path.resolve(
        process.cwd(),
        caPath,
      )

    if (
      !fs.existsSync(
        absoluteCaPath,
      )
    ) {
      throw new Error(
        `Aiven SSL CA file was not found: ${absoluteCaPath}`,
      )
    }

    ssl = {
      ca:
        fs.readFileSync(
          absoluteCaPath,
        ),
    }
  }

  return {
    host:
      url.hostname,

    port:
      Number(
        url.port ||
          3306,
      ),

    user:
      decodeURIComponent(
        url.username,
      ),

    password:
      decodeURIComponent(
        url.password,
      ),

    database:
      url.pathname.replace(
        /^\//,
        '',
      ),

    ssl,
  }
}

/* =========================================================
   NEXT LGS BUILDING NUMBER
========================================================= */

async function nextBuildingNumber(
  connection,
) {
  const [
    rows,
  ] =
    await connection.execute(
      `
      SELECT
        MAX(
          CAST(
            SUBSTRING(
              building_code,
              9
            )
            AS UNSIGNED
          )
        ) AS maxNumber

      FROM buildings

      WHERE
        building_code LIKE 'LGS-BLD-%'
      `,
    )

  return (
    Number(
      rows[0]
        ?.maxNumber ||
        0,
    ) +
    1
  )
}

function buildingCode(
  number,
) {
  return `LGS-BLD-${String(
    number,
  ).padStart(
    6,
    '0',
  )}`
}

/* =========================================================
   WRITE TO MYSQL
========================================================= */

async function syncBuildings(
  buildings,
) {
  section(
    'CONNECTING TO AIVEN',
  )

  const config =
    databaseConfig()

  console.log(
    'Host:',
    config.host,
  )

  console.log(
    'Port:',
    config.port,
  )

  console.log(
    'Database:',
    config.database,
  )

  const connection =
    await mysql.createConnection(
      config,
    )

  console.log(
    '✅ Connected to Aiven.',
  )

  let inserted =
    0

  let updated =
    0

  let nextNumber =
    await nextBuildingNumber(
      connection,
    )

  try {
    await connection.beginTransaction()

    for (
      let index =
        0;
      index <
      buildings.length;
      index++
    ) {
      const building =
        buildings[
          index
        ]

      const [
        existingRows,
      ] =
        await connection.execute(
          `
          SELECT
            id,
            building_code

          FROM buildings

          WHERE
            external_source = ?
            AND external_feature_id = ?

          LIMIT 1
          `,
          [
            EXTERNAL_SOURCE,

            building.externalFeatureId,
          ],
        )

      const existing =
        existingRows[0]

      if (
        existing
      ) {
        /*
          Preserve any manually entered or previously
          resolved human-readable data.

          Only fill name/address/type if they are currently empty.
        */
        await connection.execute(
          `
          UPDATE buildings

          SET
            name =
              CASE
                WHEN name IS NULL
                  OR TRIM(name) = ''
                THEN ?
                ELSE name
              END,

            address =
              CASE
                WHEN address IS NULL
                  OR TRIM(address) = ''
                THEN ?
                ELSE address
              END,

            building_type =
              CASE
                WHEN building_type IS NULL
                  OR TRIM(building_type) = ''
                THEN ?
                ELSE building_type
              END,

            latitude = ?,

            longitude = ?,

            geometry_json = ?,

            active = 1,

            deleted_at = NULL,

            updated_at =
              UTC_TIMESTAMP()

          WHERE
            id = ?
          `,
          [
            building.name,

            building.address,

            building.buildingType,

            building.latitude,

            building.longitude,

            building.geometryJson,

            existing.id,
          ],
        )

        updated++
      } else {
        const code =
          buildingCode(
            nextNumber,
          )

        nextNumber++

        await connection.execute(
          `
          INSERT INTO buildings (
            building_code,
            external_source,
            external_feature_id,

            name,
            resolved_name,
            address,
            building_type,

            public_facility,

            latitude,
            longitude,

            geometry_json,

            name_match_status,

            active,

            created_at,
            updated_at
          )

          VALUES (
            ?,
            ?,
            ?,

            ?,
            NULL,
            ?,
            ?,

            0,

            ?,
            ?,

            ?,

            ?,

            1,

            UTC_TIMESTAMP(),
            UTC_TIMESTAMP()
          )
          `,
          [
            code,

            EXTERNAL_SOURCE,

            building.externalFeatureId,

            building.name,

            building.address,

            building.buildingType,

            building.latitude,

            building.longitude,

            building.geometryJson,

            building.name
              ? 'NATIVE_CMC'
              : null,
          ],
        )

        inserted++
      }

      if (
        (
          index +
          1
        ) %
          50 ===
        0
      ) {
        console.log(
          `Processed ${index + 1}/${buildings.length}...`,
        )
      }
    }

    await connection.commit()

    section(
      'SYNC COMPLETE',
    )

    console.log(
      'Inserted:',
      inserted,
    )

    console.log(
      'Updated:',
      updated,
    )

    console.log(
      'Total processed:',
      buildings.length,
    )
  } catch (
    error
  ) {
    await connection.rollback()

    console.error(
      '\n❌ Sync failed. Transaction rolled back.',
    )

    throw error
  } finally {
    await connection.end()

    console.log(
      '\n🔌 Database connection closed.',
    )
  }
}

/* =========================================================
   MAIN
========================================================= */

async function main() {
  try {
    const geojson =
      await loadGeoJson()

    const buildings =
      prepareBuildings(
        geojson,
      )

    if (
      !buildings.length
    ) {
      throw new Error(
        'No valid CMC building polygons were found.',
      )
    }

    section(
      'SAMPLE BUILDINGS',
    )

    console.table(
      buildings
        .slice(
          0,
          10,
        )
        .map(
          (
            building,
          ) => ({
            externalFeatureId:
              building.externalFeatureId,

            name:
              building.name,

            address:
              building.address,

            latitude:
              building.latitude,

            longitude:
              building.longitude,
          }),
        ),
    )

    if (
      !WRITE
    ) {
      section(
        'DRY RUN COMPLETE',
      )

      console.log(
        '✅ Nothing was written to the database.',
      )

      console.log(
        '\nIf the values above look correct, run:',
      )

      console.log(
        '\nnode scripts/sync-cmc-buildings.mjs --write\n',
      )

      return
    }

    await syncBuildings(
      buildings,
    )
  } catch (
    error
  ) {
    console.error(
      '\n❌ CMC BUILDING SYNC FAILED',
    )

    console.error(
      error,
    )

    process.exitCode =
      1
  }
}

await main()