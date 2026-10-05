import mysql, {
  type RowDataPacket,
} from 'mysql2/promise'

import {
  getDatabaseSslConfig,
  parseDatabaseUrl,
} from '../src/config/db'

interface TableExistsRow
  extends RowDataPacket {
  count: number
}

interface ColumnExistsRow
  extends RowDataPacket {
  count: number
}

interface ColumnInfoRow
  extends RowDataPacket {
  Field: string
  Type: string
  Null: string
  Key: string
  Default: string | null
  Extra: string
}

async function main() {
  const db =
    parseDatabaseUrl()

  console.log(
    `Connecting to MySQL ${db.host}:${db.port}/${db.database}...`,
  )

  const connection =
    await mysql.createConnection({
      host:
        db.host,

      port:
        db.port,

      user:
        db.user,

      password:
        db.password,

      database:
        db.database,

      /*
        Use exactly the same Aiven TLS configuration
        as the normal application connection pool.
      */
      ssl:
        getDatabaseSslConfig(),

      connectTimeout:
        15_000,
    })

  try {
    console.log(
      'Secure database connection established.',
    )

    /* =====================================================
       CHECK INSPECTIONS TABLE
    ====================================================== */

    const [
      tableRows,
    ] =
      await connection.query<
        TableExistsRow[]
      >(
        `
          SELECT
            COUNT(*) AS count
          FROM information_schema.tables
          WHERE table_schema = ?
            AND table_name = 'inspections'
        `,
        [
          db.database,
        ],
      )

    const tableExists =
      Number(
        tableRows[0]?.count ??
          0,
      ) > 0

    if (
      !tableExists
    ) {
      throw new Error(
        `Table "inspections" does not exist in database "${db.database}".`,
      )
    }

    /* =====================================================
       CHECK WHETHER COLUMN ALREADY EXISTS
    ====================================================== */

    const [
      columnRows,
    ] =
      await connection.query<
        ColumnExistsRow[]
      >(
        `
          SELECT
            COUNT(*) AS count
          FROM information_schema.columns
          WHERE table_schema = ?
            AND table_name = 'inspections'
            AND column_name = 'checked_in_at'
        `,
        [
          db.database,
        ],
      )

    const checkedInAtExists =
      Number(
        columnRows[0]?.count ??
          0,
      ) > 0

    /* =====================================================
       ADD checked_in_at
    ====================================================== */

    if (
      checkedInAtExists
    ) {
      console.log(
        'skip  inspections.checked_in_at already exists',
      )
    } else {
      console.log(
        'apply add inspections.checked_in_at',
      )

      await connection.query(`
        ALTER TABLE inspections
        ADD COLUMN checked_in_at DATETIME NULL
      `)

      console.log(
        'done  inspections.checked_in_at added',
      )
    }

    /* =====================================================
       VERIFY RESULT
    ====================================================== */

    const [
      verifyRows,
    ] =
      await connection.query<
        ColumnInfoRow[]
      >(
        `
          SHOW COLUMNS
          FROM inspections
          LIKE 'checked_in_at'
        `,
      )

    const column =
      verifyRows[0]

    if (
      !column
    ) {
      throw new Error(
        'Migration verification failed: checked_in_at was not found.',
      )
    }

    console.log(
      'Verified column:',
      {
        field:
          column.Field,

        type:
          column.Type,

        nullable:
          column.Null,

        default:
          column.Default,
      },
    )

    console.log(
      'Inspection check-in migration complete.',
    )
  } finally {
    await connection.end()
  }
}

main().catch(
  (error) => {
    console.error(
      'Migration failed:',
      error,
    )

    process.exit(1)
  },
)
