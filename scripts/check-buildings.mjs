import 'dotenv/config'

import fs from 'node:fs'
import path from 'node:path'

import pg from 'pg'

const { Client } = pg

/* =========================================================
   ENV
========================================================= */

const databaseUrl = process.env.DATABASE_URL

if (!databaseUrl) {
  console.error('❌ DATABASE_URL is missing from .env')
  process.exit(1)
}

const url = new URL(databaseUrl)

/* =========================================================
   SSL
========================================================= */

let ssl = undefined

if (String(process.env.DB_SSL).toLowerCase() === 'true') {
  const caPath = process.env.DB_SSL_CA_PATH

  if (caPath) {
    const absoluteCaPath = path.resolve(process.cwd(), caPath)

    if (fs.existsSync(absoluteCaPath)) {
      ssl = {
        ca: fs.readFileSync(absoluteCaPath),
        rejectUnauthorized: true,
      }
      console.log(`🔐 Using SSL CA: ${absoluteCaPath}`)
    } else {
      console.warn(`⚠️ SSL CA file not found: ${absoluteCaPath}`)
    }
  }
}

/* =========================================================
   CONNECTION
========================================================= */

const config = {
  host: url.hostname,
  port: Number(url.port || 5432),
  user: decodeURIComponent(url.username),
  password: decodeURIComponent(url.password),
  database: url.pathname.replace(/^\//, ''),
  ssl,
}

/* =========================================================
   HELPERS
========================================================= */

function section(title) {
  console.log('\n============================================================')
  console.log(title)
  console.log('============================================================')
}

async function safeQuery(client, title, sql, params = []) {
  section(title)

  try {
    const res = await client.query(sql, params)
    console.table(res.rows)
    return res.rows
  } catch (error) {
    console.error('❌ Query failed:', error.message)
    return []
  }
}

/* =========================================================
   MAIN
========================================================= */

async function main() {
  let client

  try {
    section('CONNECTING TO POSTGRESQL')

    console.log('Host:', config.host)
    console.log('Port:', config.port)
    console.log('Database:', config.database)
    console.log('User:', config.user)

    client = new Client(config)
    await client.connect()

    console.log('\n✅ Connected successfully.')

    /* =====================================================
       DATABASE INFO
    ===================================================== */

    await safeQuery(
      client,
      'DATABASE CONNECTION INFO',
      `
        SELECT
          current_database() AS "currentDatabase",
          CURRENT_TIMESTAMP AS "databaseTime",
          version() AS "postgresVersion"
      `,
    )

    /* =====================================================
       CHECK TABLE
    ===================================================== */

    await safeQuery(
      client,
      'BUILDINGS TABLE COLUMNS',
      `
        SELECT column_name, data_type, is_nullable
        FROM information_schema.columns
        WHERE table_name = 'buildings'
        ORDER BY ordinal_position
      `,
    )

    /* =====================================================
       TOTAL BUILDINGS
    ===================================================== */

    await safeQuery(
      client,
      'TOTAL BUILDINGS',
      `
        SELECT
          COUNT(*) AS "totalBuildings"
        FROM buildings
        WHERE deleted_at IS NULL
      `,
    )

    /* =====================================================
       BUILDINGS WITH COORDINATES
    ===================================================== */

    await safeQuery(
      client,
      'BUILDINGS WITH COORDINATES',
      `
        SELECT
          COUNT(*) AS "totalBuildings",
          COUNT(*) FILTER (WHERE latitude IS NOT NULL AND longitude IS NOT NULL) AS "withCoordinates",
          COUNT(*) FILTER (WHERE latitude IS NULL OR longitude IS NULL) AS "withoutCoordinates"
        FROM buildings
        WHERE deleted_at IS NULL
      `,
    )

    /* =====================================================
       SAMPLE BUILDINGS
    ===================================================== */

    await safeQuery(
      client,
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
        WHERE deleted_at IS NULL
        ORDER BY id
        LIMIT 20
      `,
    )

    /* =====================================================
       SEARCH
    ===================================================== */

    const searchTerm =
      process.argv.slice(2).join(' ').trim() || 'nelum'

    const like = `%${searchTerm}%`

    await safeQuery(
      client,
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
            b.building_code LIKE $1
            OR b.external_feature_id LIKE $2
            OR b.name LIKE $3
            OR b.resolved_name LIKE $4
            OR b.address LIKE $5
            OR EXISTS (
              SELECT 1
              FROM building_aliases ba
              WHERE ba.building_id = b.id
                AND ba.name LIKE $6
            )
          )
        LIMIT 50
      `,
      [like, like, like, like, like, like],
    )

    /* =====================================================
       ALIASES
    ===================================================== */

    await safeQuery(
      client,
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
        JOIN buildings b ON b.id = ba.building_id
        ORDER BY ba.id DESC
        LIMIT 30
      `,
    )

    /* =====================================================
       RESOLVED NAME STATISTICS
    ===================================================== */

    await safeQuery(
      client,
      'BUILDING NAME RESOLUTION STATUS',
      `
        SELECT
          COUNT(*) AS total,
          COUNT(*) FILTER (WHERE name IS NOT NULL AND TRIM(name) <> '') AS "withNativeName",
          COUNT(*) FILTER (WHERE resolved_name IS NOT NULL AND TRIM(resolved_name) <> '') AS "withResolvedName",
          COUNT(*) FILTER (
            WHERE (name IS NULL OR TRIM(name) = '')
              AND (resolved_name IS NULL OR TRIM(resolved_name) = '')
          ) AS "withoutAnyName"
        FROM buildings
        WHERE deleted_at IS NULL
      `,
    )

    section('FINISHED')
    console.log('✅ Building database diagnostics completed.')
  } catch (error) {
    console.error('\n❌ DATABASE CONNECTION FAILED', error)
    process.exitCode = 1
  } finally {
    if (client) {
      await client.end()
      console.log('\n🔌 Database connection closed.')
    }
  }
}

await main()