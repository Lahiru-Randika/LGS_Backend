import fs from 'node:fs/promises'
import path from 'node:path'

import mysql, {
  type RowDataPacket,
} from 'mysql2/promise'

import {
  getDatabaseSslConfig,
  parseDatabaseUrl,
} from '../src/config/db'

interface MigrationRow
  extends RowDataPacket {
  name: string
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
        Use exactly the same verified Aiven TLS configuration
        as the normal application connection pool.
      */
      ssl:
        getDatabaseSslConfig(),

      multipleStatements:
        true,

      connectTimeout:
        15_000,
    })

  try {
    console.log(
      'Secure database connection established.',
    )

    /* =====================================================
       MIGRATION HISTORY TABLE
    ====================================================== */

    await connection.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name VARCHAR(255) NOT NULL PRIMARY KEY,
        applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
      ENGINE=InnoDB
      DEFAULT CHARSET=utf8mb4
      COLLATE=utf8mb4_0900_ai_ci
    `)

    /* =====================================================
       FIND ALREADY APPLIED MIGRATIONS
    ====================================================== */

    const [
      appliedRows,
    ] =
      await connection.query<
        MigrationRow[]
      >(
        'SELECT name FROM schema_migrations ORDER BY name',
      )

    const applied =
      new Set(
        appliedRows.map(
          (row) =>
            row.name,
        ),
      )

    /* =====================================================
       READ MIGRATION FILES
    ====================================================== */

    const migrationsDir =
      path.resolve(
        process.cwd(),
        'migrations',
      )

    const files =
      (
        await fs.readdir(
          migrationsDir,
        )
      )
        .filter(
          (name) =>
            name.endsWith(
              '.sql',
            ),
        )
        .sort()

    if (!files.length) {
      console.log(
        'No migration files found.',
      )

      return
    }

    /* =====================================================
       APPLY MIGRATIONS
    ====================================================== */

    for (
      const name of files
    ) {
      if (
        applied.has(name)
      ) {
        console.log(
          `skip  ${name}`,
        )

        continue
      }

      console.log(
        `apply ${name}`,
      )

      const filePath =
        path.join(
          migrationsDir,
          name,
        )

      const sql =
        await fs.readFile(
          filePath,
          'utf8',
        )

      /*
        Individual migration files may contain multiple SQL
        statements. multipleStatements=true is enabled only
        for this trusted local migration runner.
      */
      await connection.query(
        sql,
      )

      await connection.execute(
        `
          INSERT INTO schema_migrations
            (name)
          VALUES (?)
        `,
        [name],
      )

      console.log(
        `done  ${name}`,
      )
    }

    console.log(
      'Migrations complete.',
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