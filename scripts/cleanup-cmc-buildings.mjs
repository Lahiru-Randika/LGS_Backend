import 'dotenv/config'

import fs from 'node:fs'
import path from 'node:path'

import mysql from 'mysql2/promise'

const args =
  process.argv.slice(2)

const WRITE =
  args.includes('--write')

const expectedIndex =
  args.indexOf('--expected')

const EXPECTED =
  expectedIndex >= 0
    ? Number(
        args[
          expectedIndex + 1
        ],
      )
    : null

const EXTERNAL_SOURCE =
  'CMC_VISIGEO'

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

function safeIdentifier(
  value,
) {
  if (
    !/^[A-Za-z0-9_]+$/.test(
      value,
    )
  ) {
    throw new Error(
      `Unsafe SQL identifier: ${value}`,
    )
  }

  return `\`${value}\``
}

/* =========================================================
   DATABASE CONFIG
========================================================= */

function databaseConfig() {
  const databaseUrl =
    process.env.DATABASE_URL

  if (!databaseUrl) {
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
      process.env.DB_SSL,
    ).toLowerCase() ===
    'true'
  ) {
    const caPath =
      process.env.DB_SSL_CA_PATH

    if (!caPath) {
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
        `SSL CA file not found: ${absoluteCaPath}`,
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
   MAIN
========================================================= */

async function main() {
  let connection

  try {
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
      'Database:',
      config.database,
    )

    console.log(
      'Mode:',
      WRITE
        ? 'DELETE CMC IMPORT'
        : 'DRY RUN',
    )

    connection =
      await mysql.createConnection(
        config,
      )

    console.log(
      '✅ Connected.',
    )

    /* =====================================================
       COUNT CURRENT CMC BUILDINGS
    ===================================================== */

    const [
      countRows,
    ] =
      await connection.execute(
        `
        SELECT
          COUNT(*) AS total

        FROM buildings

        WHERE
          external_source = ?
          AND deleted_at IS NULL
        `,
        [
          EXTERNAL_SOURCE,
        ],
      )

    const total =
      Number(
        countRows[0]
          ?.total ||
          0,
      )

    section(
      'CMC ROWS TO REMOVE',
    )

    console.log(
      'CMC buildings:',
      total,
    )

    /*
      Extra safety.

      We currently expect 406 rows from the broken import.
    */
    if (
      WRITE &&
      EXPECTED !== null &&
      total !==
        EXPECTED
    ) {
      throw new Error(
        `Safety check failed. Expected ${EXPECTED} rows but found ${total}. Nothing was deleted.`,
      )
    }

    /* =====================================================
       FIND ALL FOREIGN KEYS REFERENCING BUILDINGS
    ===================================================== */

    const [
      foreignKeys,
    ] =
      await connection.execute(
        `
        SELECT
          TABLE_NAME AS tableName,
          COLUMN_NAME AS columnName,
          REFERENCED_COLUMN_NAME AS referencedColumnName,
          CONSTRAINT_NAME AS constraintName

        FROM information_schema.KEY_COLUMN_USAGE

        WHERE
          REFERENCED_TABLE_SCHEMA = DATABASE()
          AND REFERENCED_TABLE_NAME = 'buildings'
          AND REFERENCED_COLUMN_NAME IS NOT NULL
        `,
      )

    section(
      'FOREIGN KEY SAFETY CHECK',
    )

    let totalReferences =
      0

    const referenceResults =
      []

    for (
      const fk of foreignKeys
    ) {
      const table =
        safeIdentifier(
          fk.tableName,
        )

      const column =
        safeIdentifier(
          fk.columnName,
        )

      const referencedColumn =
        safeIdentifier(
          fk.referencedColumnName,
        )

      const [
        rows,
      ] =
        await connection.execute(
          `
          SELECT
            COUNT(*) AS total

          FROM ${table} child

          JOIN buildings b
            ON child.${column} =
               b.${referencedColumn}

          WHERE
            b.external_source = ?
          `,
          [
            EXTERNAL_SOURCE,
          ],
        )

      const count =
        Number(
          rows[0]
            ?.total ||
            0,
        )

      totalReferences +=
        count

      referenceResults.push(
        {
          table:
            fk.tableName,

          column:
            fk.columnName,

          constraint:
            fk.constraintName,

          references:
            count,
        },
      )
    }

    if (
      referenceResults.length
    ) {
      console.table(
        referenceResults,
      )
    } else {
      console.log(
        'No foreign keys reference buildings.',
      )
    }

    console.log(
      '\nTotal references to imported CMC buildings:',
      totalReferences,
    )

    /*
      VERY IMPORTANT:

      If requests, properties, tax records, etc.
      already reference these buildings, we do NOT delete them.
    */
    if (
      totalReferences >
      0
    ) {
      console.error(
        '\n❌ CLEANUP BLOCKED.',
      )

      console.error(
        'Some CMC buildings are already referenced by other tables.',
      )

      console.error(
        'Nothing will be deleted.',
      )

      process.exitCode =
        1

      return
    }

    /* =====================================================
       DRY RUN
    ===================================================== */

    if (!WRITE) {
      section(
        'DRY RUN COMPLETE',
      )

      console.log(
        '✅ No data was deleted.',
      )

      console.log(
        '✅ No foreign-key references were found.',
      )

      console.log(
        '\nIf CMC buildings = 406, run:',
      )

      console.log(
        '\nnode scripts/cleanup-cmc-buildings.mjs --write --expected 406\n',
      )

      return
    }

    /* =====================================================
       DELETE
    ===================================================== */

    section(
      'DELETING OLD CMC IMPORT',
    )

    await connection.beginTransaction()

    try {
      const [
        result,
      ] =
        await connection.execute(
          `
          DELETE FROM buildings

          WHERE
            external_source = ?
          `,
          [
            EXTERNAL_SOURCE,
          ],
        )

      await connection.commit()

      console.log(
        '✅ Cleanup completed.',
      )

      console.log(
        'Deleted:',
        result.affectedRows,
      )
    } catch (
      error
    ) {
      await connection.rollback()

      throw error
    }

    /* =====================================================
       VERIFY
    ===================================================== */

    const [
      remainingRows,
    ] =
      await connection.execute(
        `
        SELECT
          COUNT(*) AS total

        FROM buildings

        WHERE
          external_source = ?
        `,
        [
          EXTERNAL_SOURCE,
        ],
      )

    console.log(
      'Remaining CMC buildings:',
      Number(
        remainingRows[0]
          ?.total ||
          0,
      ),
    )
  } catch (
    error
  ) {
    console.error(
      '\n❌ CLEANUP FAILED',
    )

    console.error(
      error,
    )

    process.exitCode =
      1
  } finally {
    if (connection) {
      await connection.end()

      console.log(
        '\n🔌 Database connection closed.',
      )
    }
  }
}

await main()