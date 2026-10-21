import 'dotenv/config'

import fs from 'node:fs'
import path from 'node:path'

import pg from 'pg'

const { Client } = pg

const args = process.argv.slice(2)
const WRITE = args.includes('--write')
const expectedIndex = args.indexOf('--expected')
const EXPECTED = expectedIndex >= 0 ? Number(args[expectedIndex + 1]) : null
const EXTERNAL_SOURCE = 'CMC_VISIGEO'

/* =========================================================
   HELPERS
========================================================= */

function section(title) {
  console.log('\n============================================================')
  console.log(title)
  console.log('============================================================')
}

function safeIdentifier(value) {
  if (!/^[A-Za-z0-9_]+$/.test(value)) {
    throw new Error(`Unsafe SQL identifier: ${value}`)
  }
  return `"${value}"`
}

/* =========================================================
   DATABASE CONFIG
========================================================= */

function databaseConfig() {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is missing from .env')
  }

  const url = new URL(databaseUrl)
  let ssl

  if (String(process.env.DB_SSL).toLowerCase() === 'true') {
    const caPath = process.env.DB_SSL_CA_PATH
    if (!caPath) {
      throw new Error('DB_SSL=true but DB_SSL_CA_PATH is missing.')
    }

    const absoluteCaPath = path.resolve(process.cwd(), caPath)
    if (!fs.existsSync(absoluteCaPath)) {
      throw new Error(`SSL CA file not found: ${absoluteCaPath}`)
    }

    ssl = {
      ca: fs.readFileSync(absoluteCaPath),
      rejectUnauthorized: true,
    }
  }

  return {
    host: url.hostname,
    port: Number(url.port || 5432),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: url.pathname.replace(/^\//, ''),
    ssl,
  }
}

/* =========================================================
   MAIN
========================================================= */

async function main() {
  let client

  try {
    section('CONNECTING TO POSTGRESQL')

    const config = databaseConfig()
    console.log('Host:', config.host)
    console.log('Database:', config.database)
    console.log('Mode:', WRITE ? 'DELETE CMC IMPORT' : 'DRY RUN')

    client = new Client(config)
    await client.connect()
    console.log('✅ Connected.')

    /* =====================================================
       COUNT CURRENT CMC BUILDINGS
    ===================================================== */

    const countRes = await client.query(
      `
      SELECT COUNT(*) AS total
      FROM buildings
      WHERE external_source = $1
        AND deleted_at IS NULL
      `,
      [EXTERNAL_SOURCE],
    )

    const total = Number(countRes.rows[0]?.total || 0)

    section('CMC ROWS TO REMOVE')
    console.log('CMC buildings:', total)

    if (WRITE && EXPECTED !== null && total !== EXPECTED) {
      throw new Error(
        `Safety check failed. Expected ${EXPECTED} rows but found ${total}. Nothing was deleted.`,
      )
    }

    /* =====================================================
       FIND ALL FOREIGN KEYS REFERENCING BUILDINGS
    ===================================================== */

    const fkRes = await client.query(
      `
      SELECT
        tc.table_name AS "tableName",
        kcu.column_name AS "columnName",
        ccu.column_name AS "referencedColumnName",
        tc.constraint_name AS "constraintName"
      FROM information_schema.table_constraints AS tc
      JOIN information_schema.key_column_usage AS kcu
        ON tc.constraint_name = kcu.constraint_name
        AND tc.table_schema = kcu.table_schema
      JOIN information_schema.constraint_column_usage AS ccu
        ON ccu.constraint_name = tc.constraint_name
        AND ccu.table_schema = tc.table_schema
      WHERE tc.constraint_type = 'FOREIGN KEY'
        AND ccu.table_name = 'buildings'
        AND tc.table_schema = 'public'
      `,
    )

    section('FOREIGN KEY SAFETY CHECK')

    let totalReferences = 0
    const referenceResults = []

    for (const fk of fkRes.rows) {
      const table = safeIdentifier(fk.tableName)
      const column = safeIdentifier(fk.columnName)
      const referencedColumn = safeIdentifier(fk.referencedColumnName)

      const refRes = await client.query(
        `
        SELECT COUNT(*) AS total
        FROM ${table} child
        JOIN buildings b ON child.${column} = b.${referencedColumn}
        WHERE b.external_source = $1
        `,
        [EXTERNAL_SOURCE],
      )

      const count = Number(refRes.rows[0]?.total || 0)
      totalReferences += count

      referenceResults.push({
        table: fk.tableName,
        column: fk.columnName,
        constraint: fk.constraintName,
        references: count,
      })
    }

    if (referenceResults.length) {
      console.table(referenceResults)
    } else {
      console.log('No foreign keys reference buildings.')
    }

    console.log('\nTotal references to imported CMC buildings:', totalReferences)

    if (totalReferences > 0) {
      console.error('\n❌ CLEANUP BLOCKED.')
      console.error('Some CMC buildings are already referenced by other tables.')
      console.error('Nothing will be deleted.')
      process.exitCode = 1
      return
    }

    /* =====================================================
       DRY RUN
    ===================================================== */

    if (!WRITE) {
      section('DRY RUN COMPLETE')
      console.log('✅ No data was deleted.')
      console.log('✅ No foreign-key references were found.')
      console.log('\nIf CMC buildings = 406, run:')
      console.log('\nnode scripts/cleanup-cmc-buildings.mjs --write --expected 406\n')
      return
    }

    /* =====================================================
       DELETE
    ===================================================== */

    section('DELETING OLD CMC IMPORT')

    await client.query('BEGIN')

    try {
      const deleteRes = await client.query(
        `
        DELETE FROM buildings
        WHERE external_source = $1
        `,
        [EXTERNAL_SOURCE],
      )

      await client.query('COMMIT')
      console.log('✅ Cleanup completed.')
      console.log('Deleted:', deleteRes.rowCount)
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    }

    /* =====================================================
       VERIFY
    ===================================================== */

    const remainingRes = await client.query(
      `
      SELECT COUNT(*) AS total
      FROM buildings
      WHERE external_source = $1
      `,
      [EXTERNAL_SOURCE],
    )

    console.log('Remaining CMC buildings:', Number(remainingRes.rows[0]?.total || 0))
  } catch (error) {
    console.error('\n❌ CLEANUP FAILED', error)
    process.exitCode = 1
  } finally {
    if (client) {
      await client.end()
      console.log('\n🔌 Database connection closed.')
    }
  }
}

await main()