import 'dotenv/config'
import fs from 'node:fs'
import path from 'node:path'
import { Client } from 'pg'

function getSslConfig() {
  const enabled = process.env.DB_SSL?.toLowerCase() === 'true'
  if (!enabled) {
    return undefined
  }

  const caPath = process.env.DB_SSL_CA_PATH
  if (!caPath) {
    throw new Error('DB_SSL=true but DB_SSL_CA_PATH is not configured')
  }

  const absoluteCaPath = path.resolve(process.cwd(), caPath)
  if (!fs.existsSync(absoluteCaPath)) {
    throw new Error(`Database CA certificate not found: ${absoluteCaPath}`)
  }

  return {
    ca: fs.readFileSync(absoluteCaPath, 'utf8'),
    rejectUnauthorized: true,
  }
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required')
  }

  const url = new URL(databaseUrl)
  const databaseName = url.pathname.replace(/^\//, '')
  if (!databaseName) {
    throw new Error('DATABASE_URL must contain a database name')
  }

  /*
    Connect to administrative default database (postgres) to check and create
    the target database if server permissions permit.
  */
  const adminDb = 'postgres'
  const client = new Client({
    host: url.hostname,
    port: Number(url.port) || 5432,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: adminDb,
    ssl: getSslConfig(),
    connectionTimeoutMillis: 15_000,
  })

  try {
    await client.connect()

    const checkRes = await client.query(
      'SELECT 1 FROM pg_database WHERE datname = $1',
      [databaseName],
    )

    if (checkRes.rowCount && checkRes.rowCount > 0) {
      console.log(`Database "${databaseName}" already exists.`)
    } else {
      // Escape double quotes for identifier safety
      const safeDbName = databaseName.replace(/"/g, '""')
      await client.query(`CREATE DATABASE "${safeDbName}" WITH ENCODING 'UTF8'`)
      console.log(`Database "${databaseName}" created successfully.`)
    }
  } catch (error: any) {
    // If user has no permission to connect to 'postgres' or create database,
    // as is common in DigitalOcean Managed PostgreSQL:
    if (error?.code === '42501' || error?.message?.includes('permission denied')) {
      console.log(
        `Note: Managed PostgreSQL user cannot create databases directly. ` +
        `Ensure database "${databaseName}" is created in your cloud console. Continuing...`,
      )
    } else {
      console.warn(`Database creation note (${error?.code || 'info'}): ${error?.message}`)
      console.log(`Proceeding on assumption database "${databaseName}" is pre-created in console.`)
    }
  } finally {
    try {
      await client.end()
    } catch {
      // ignore
    }
  }
}

main().catch((error) => {
  console.error('Database creation script failed:', error)
  process.exit(1)
})