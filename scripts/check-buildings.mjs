import 'dotenv/config'

import fs from 'node:fs'
import path from 'node:path'

import mysql from 'mysql2/promise'

/* =========================================================
   ENV
========================================================= */

const databaseUrl =
  process.env.DATABASE_URL

if (!databaseUrl) {
  console.error(
    '❌ DATABASE_URL is missing from .env',
  )

  process.exit(1)
}

const url =
  new URL(
    databaseUrl,
  )

/* =========================================================
   SSL

   Compatible with your Aiven setup:

   DB_SSL=true
   DB_SSL_CA_PATH=./certs/ca.pem
========================================================= */

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
    const absoluteCaPath =
      path.resolve(
        process.cwd(),
        caPath,
      )

    if (
      fs.existsSync(
        absoluteCaPath,
      )
    ) {
      ssl = {
        ca:
          fs.readFileSync(
            absoluteCaPath,
          ),
      }

      console.log(
        `🔐 Using SSL CA: ${absoluteCaPath}`,
      )
    } else {
      console.warn(
        `⚠️ SSL CA file not found: ${absoluteCaPath}`,
      )

      /*
        Do NOT disable certificate verification here.

        Better to fix the path if Aiven requires the CA.
      */
    }
  }
}

/* =========================================================
   CONNECTION
========================================================= */

const config = {
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

/* =========================================================
   HELPERS
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

async function safeQuery(
  connection,
  title,
  sql,
  params = [],
) {
  section(
    title,
  )

  try {
    const [
      rows,
    ] =
      await connection.execute(
        sql,
        params,
      )

    console.table(
      rows,
    )

    return rows
  } catch (
    error
  ) {
    console.error(
      '❌ Query failed:',
      error.message,
    )

    return []
  }
}

/* =========================================================
   MAIN
========================================================= */

async function main() {
  let connection

  try {
    section(
      'CONNECTING TO AIVEN MYSQL',
    )

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

    console.log(
      'User:',
      config.user,
    )

    /*
      Password intentionally not printed.
    */

    connection =
      await mysql.createConnection(
        config,
      )

    console.log(
      '\n✅ Connected successfully.',
    )

    /* =====================================================
       DATABASE INFO
    ===================================================== */

    await safeQuery(
      connection,
      'DATABASE CONNECTION INFO',
      `
        SELECT
          DATABASE() AS currentDatabase,
          UTC_TIMESTAMP() AS databaseTime,
          VERSION() AS mysqlVersion
      `,
    )

    /* =====================================================
       CHECK TABLE
    ===================================================== */

    await safeQuery(
      connection,
      'BUILDINGS TABLE COLUMNS',
      `
        SHOW COLUMNS
        FROM buildings
      `,
    )

    /* =====================================================
       TOTAL BUILDINGS
    ===================================================== */

    await safeQuery(
      connection,
      'TOTAL BUILDINGS',
      `
        SELECT
          COUNT(*) AS totalBuildings
        FROM buildings
        WHERE deleted_at IS NULL
      `,
    )

    /* =====================================================
       BUILDINGS WITH COORDINATES
    ===================================================== */

    await safeQuery(
      connection,
      'BUILDINGS WITH COORDINATES',
      `
        SELECT
          COUNT(*) AS totalBuildings,

          SUM(
            CASE
              WHEN latitude IS NOT NULL
               AND longitude IS NOT NULL
              THEN 1
              ELSE 0
            END
          ) AS withCoordinates,

          SUM(
            CASE
              WHEN latitude IS NULL
                OR longitude IS NULL
              THEN 1
              ELSE 0
            END
          ) AS withoutCoordinates

        FROM buildings

        WHERE
          deleted_at IS NULL
      `,
    )

    /* =====================================================
       SAMPLE BUILDINGS
    ===================================================== */

    await safeQuery(
      connection,
      'SAMPLE BUILDINGS',
      `
        SELECT
          id,
          building_code,
          external_feature_id,
          name,
          resolved_name,
          address,
          latitude,
          longitude,
          name_match_status

        FROM buildings

        WHERE
          deleted_at IS NULL

        ORDER BY id

        LIMIT 20
      `,
    )

    /* =====================================================
       SEARCH

       Usage:

       node scripts/check-buildings.mjs nelum

       node scripts/check-buildings.mjs town

       node scripts/check-buildings.mjs "nelum pokuna"
    ===================================================== */

    const searchTerm =
      process.argv
        .slice(
          2,
        )
        .join(
          ' ',
        )
        .trim() ||
      'nelum'

    const like =
      `%${searchTerm}%`

    await safeQuery(
      connection,
      `SEARCH BUILDINGS FOR "${searchTerm}"`,
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
          b.name_match_status

        FROM buildings b

        WHERE
          b.deleted_at IS NULL

          AND (
            b.building_code LIKE ?

            OR b.external_feature_id LIKE ?

            OR b.name LIKE ?

            OR b.resolved_name LIKE ?

            OR b.address LIKE ?

            OR EXISTS (
              SELECT 1

              FROM building_aliases ba

              WHERE
                ba.building_id =
                  b.id

                AND ba.name LIKE ?
            )
          )

        LIMIT 50
      `,
      [
        like,
        like,
        like,
        like,
        like,
        like,
      ],
    )

    /* =====================================================
       ALIASES
    ===================================================== */

    await safeQuery(
      connection,
      'SAMPLE BUILDING ALIASES',
      `
        SELECT
          ba.id,
          ba.building_id,
          b.building_code,
          ba.name,
          ba.source,
          ba.confidence,
          ba.is_primary

        FROM building_aliases ba

        JOIN buildings b
          ON b.id =
             ba.building_id

        ORDER BY
          ba.id DESC

        LIMIT 30
      `,
    )

    /* =====================================================
       RESOLVED NAME STATISTICS
    ===================================================== */

    await safeQuery(
      connection,
      'BUILDING NAME RESOLUTION STATUS',
      `
        SELECT
          COUNT(*) AS total,

          SUM(
            CASE
              WHEN name IS NOT NULL
               AND TRIM(name) <> ''
              THEN 1
              ELSE 0
            END
          ) AS withNativeName,

          SUM(
            CASE
              WHEN resolved_name IS NOT NULL
               AND TRIM(resolved_name) <> ''
              THEN 1
              ELSE 0
            END
          ) AS withResolvedName,

          SUM(
            CASE
              WHEN (
                name IS NULL
                OR TRIM(name) = ''
              )
              AND (
                resolved_name IS NULL
                OR TRIM(resolved_name) = ''
              )
              THEN 1
              ELSE 0
            END
          ) AS withoutAnyName

        FROM buildings

        WHERE
          deleted_at IS NULL
      `,
    )

    section(
      'FINISHED',
    )

    console.log(
      '✅ Building database diagnostics completed.',
    )
  } catch (
    error
  ) {
    console.error(
      '\n❌ DATABASE CONNECTION FAILED',
    )

    console.error(
      error,
    )

    process.exitCode =
      1
  } finally {
    if (
      connection
    ) {
      await connection.end()

      console.log(
        '\n🔌 Database connection closed.',
      )
    }
  }
}

await main()