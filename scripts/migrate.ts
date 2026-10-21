import fs from 'node:fs/promises'
import path from 'node:path'
import { Client } from 'pg'
import { getDatabaseSslConfig, parseDatabaseUrl } from '../src/config/db'

async function main() {
  const db = parseDatabaseUrl()

  console.log(`Connecting to PostgreSQL ${db.host}:${db.port}/${db.database}...`)

  const client = new Client({
    host: db.host,
    port: db.port,
    user: db.user,
    password: db.password,
    database: db.database,
    ssl: getDatabaseSslConfig(),
    connectionTimeoutMillis: 15_000,
  })

  await client.connect()

  try {
    console.log('Secure database connection established.')

    /* =====================================================
       MIGRATION HISTORY TABLE
    ====================================================== */

    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name VARCHAR(255) NOT NULL PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `)

    /* =====================================================
       FIND ALREADY APPLIED MIGRATIONS
    ====================================================== */

    const appliedRes = await client.query<{ name: string }>(
      'SELECT name FROM schema_migrations ORDER BY name'
    )
    const applied = new Set(appliedRes.rows.map((row) => row.name))

    /* =====================================================
       READ MIGRATION FILES
    ====================================================== */

    const migrationsDir = path.resolve(process.cwd(), 'migrations')
    const files = (await fs.readdir(migrationsDir))
      .filter((name) => name.endsWith('.sql'))
      .sort()

    if (!files.length) {
      console.log('No migration files found.')
      return
    }

    /* =====================================================
       APPLY MIGRATIONS
    ====================================================== */

    for (const name of files) {
      if (applied.has(name)) {
        console.log(`skip  ${name}`)
        continue
      }

      console.log(`apply ${name}`)
      const filePath = path.join(migrationsDir, name)
      const sql = await fs.readFile(filePath, 'utf8')

      // Execute migration file
      await client.query(sql)

      await client.query(
        `INSERT INTO schema_migrations (name) VALUES ($1) ON CONFLICT (name) DO NOTHING`,
        [name]
      )

      console.log(`done  ${name}`)
    }

    console.log('Migrations complete.')
  } finally {
    await client.end()
  }
}

main().catch((error) => {
  console.error('Migration failed:', error)
  process.exit(1)
})