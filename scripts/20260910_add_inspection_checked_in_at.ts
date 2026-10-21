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

    const tableRows = await client.query<{ count: string }>(
      `SELECT COUNT(*) AS count
         FROM information_schema.tables
        WHERE table_schema = current_schema()
          AND table_name = 'inspections'`,
    )

    const tableExists = Number(tableRows.rows[0]?.count ?? 0) > 0
    if (!tableExists) {
      throw new Error(`Table "inspections" does not exist in database "${db.database}".`)
    }

    const columnRows = await client.query<{ count: string }>(
      `SELECT COUNT(*) AS count
         FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'inspections'
          AND column_name = 'checked_in_at'`,
    )

    const checkedInAtExists = Number(columnRows.rows[0]?.count ?? 0) > 0

    if (checkedInAtExists) {
      console.log('skip  inspections.checked_in_at already exists')
    } else {
      console.log('apply add inspections.checked_in_at')
      await client.query(`ALTER TABLE inspections ADD COLUMN IF NOT EXISTS checked_in_at TIMESTAMPTZ NULL`)
      console.log('done  inspections.checked_in_at added')
    }

    console.log('Inspection check-in migration complete.')
  } finally {
    await client.end()
  }
}

main().catch((error) => {
  console.error('Migration failed:', error)
  process.exit(1)
})
