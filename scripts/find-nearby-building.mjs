import 'dotenv/config'

import fs from 'node:fs'
import path from 'node:path'

import mysql from 'mysql2/promise'

const databaseUrl =
  process.env.DATABASE_URL

if (
  !databaseUrl
) {
  throw new Error(
    'DATABASE_URL is missing.',
  )
}

const latitude =
  Number(
    process.argv[2],
  )

const longitude =
  Number(
    process.argv[3],
  )

const radius =
  Number(
    process.argv[4] ||
      250,
  )

if (
  !Number.isFinite(
    latitude,
  ) ||
  !Number.isFinite(
    longitude,
  )
) {
  console.error(
    `
Usage:

node scripts/find-nearby-building.mjs <latitude> <longitude> [radiusMeters]

Example:

node scripts/find-nearby-building.mjs 6.91025 79.86140 250
`,
  )

  process.exit(
    1,
  )
}

const url =
  new URL(
    databaseUrl,
  )

let ssl =
  undefined

if (
  String(
    process.env.DB_SSL,
  ).toLowerCase() ===
  'true'
) {
  const caPath =
    process.env.DB_SSL_CA_PATH

  if (
    caPath
  ) {
    const absolute =
      path.resolve(
        process.cwd(),
        caPath,
      )

    if (
      fs.existsSync(
        absolute,
      )
    ) {
      ssl = {
        ca:
          fs.readFileSync(
            absolute,
          ),
      }
    }
  }
}

const connection =
  await mysql.createConnection(
    {
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
    },
  )

console.log(
  `\nSearching within ${radius} m of ${latitude}, ${longitude}\n`,
)

const [
  rows,
] =
  await connection.execute(
    `
      SELECT
        b.id,
        b.building_code,
        b.external_feature_id,
        b.name,
        b.resolved_name,
        b.address,
        b.latitude,
        b.longitude,

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
        ) AS distanceMeters

      FROM buildings b

      WHERE
        b.deleted_at IS NULL

        AND b.latitude IS NOT NULL

        AND b.longitude IS NOT NULL

      HAVING
        distanceMeters <= ?

      ORDER BY
        distanceMeters ASC

      LIMIT 30
    `,
    [
      latitude,
      latitude,
      longitude,
      radius,
    ],
  )

console.table(
  rows,
)

await connection.end()