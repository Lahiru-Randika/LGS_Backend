import fs from 'node:fs'
import path from 'node:path'

import mysql, {
  type Pool,
  type PoolConnection,
  type RowDataPacket,
} from 'mysql2/promise'

import { env } from './env'

/* =========================================================
   DATABASE URL PARSER
========================================================= */

export interface ParsedDatabaseUrl {
  host: string
  port: number
  user: string
  password: string
  database: string
}

export function parseDatabaseUrl(
  databaseUrl = env.DATABASE_URL,
): ParsedDatabaseUrl {
  const url = new URL(databaseUrl)

  if (url.protocol !== 'mysql:') {
    throw new Error(
      'DATABASE_URL must use mysql://',
    )
  }

  const database = decodeURIComponent(
    url.pathname.replace(/^\//, ''),
  )

  if (!database) {
    throw new Error(
      'DATABASE_URL must include a database name',
    )
  }

  return {
    host: url.hostname,

    port:
      Number(url.port) ||
      3306,

    user:
      decodeURIComponent(
        url.username,
      ),

    password:
      decodeURIComponent(
        url.password,
      ),

    database,
  }
}

/* =========================================================
   DATABASE SSL / TLS
========================================================= */

export function getDatabaseSslConfig() {
  if (!env.DB_SSL) {
    return undefined
  }

  const configuredPath =
    process.env.DB_SSL_CA_PATH?.trim()

  if (!configuredPath) {
    throw new Error(
      'DB_SSL=true but DB_SSL_CA_PATH is missing. ' +
        'Example: DB_SSL_CA_PATH=./certs/ca.pem',
    )
  }

  const caPath =
    path.isAbsolute(configuredPath)
      ? configuredPath
      : path.resolve(
          process.cwd(),
          configuredPath,
        )

  if (!fs.existsSync(caPath)) {
    throw new Error(
      `Database CA certificate not found: ${caPath}`,
    )
  }

  const ca = fs.readFileSync(
    caPath,
    'utf8',
  )

  return {
    ca,

    /*
      Verify the Aiven server certificate.
      Do NOT change this to false.
    */
    rejectUnauthorized: true,
  }
}

/* =========================================================
   DATABASE CONNECTION POOL
========================================================= */

const db = parseDatabaseUrl()

export const pool: Pool =
  mysql.createPool({
    host: db.host,

    port: db.port,

    user: db.user,

    password: db.password,

    database: db.database,

    connectionLimit:
      env.DB_CONNECTION_LIMIT,

    waitForConnections:
      true,

    queueLimit:
      0,

    enableKeepAlive:
      true,

    keepAliveInitialDelay:
      0,

    charset:
      'utf8mb4',

    timezone:
      'Z',

    ssl:
      getDatabaseSslConfig(),

    connectTimeout:
      15_000,
  })

/* =========================================================
   TRANSACTION HELPER

   Used by backend modules that need atomic DB operations.
========================================================= */

export async function withTransaction<T>(
  work: (
    connection: PoolConnection,
  ) => Promise<T>,
): Promise<T> {
  const connection =
    await pool.getConnection()

  try {
    await connection.beginTransaction()

    const result =
      await work(connection)

    await connection.commit()

    return result
  } catch (error) {
    try {
      await connection.rollback()
    } catch {
      // Keep the original error.
    }

    throw error
  } finally {
    connection.release()
  }
}

/* =========================================================
   DATABASE HEALTH CHECK

   app.ts imports this function for GET /health
========================================================= */

export async function dbPing(): Promise<boolean> {
  try {
    const [rows] =
      await pool.query<RowDataPacket[]>(
        'SELECT 1 AS ok',
      )

    return Number(
      rows[0]?.ok,
    ) === 1
  } catch (error) {
    console.error(
      'Database health check failed:',
      error,
    )

    return false
  }
}

/* =========================================================
   OPTIONAL CONNECTION TEST
========================================================= */

export async function testDatabaseConnection(): Promise<boolean> {
  const connection =
    await pool.getConnection()

  try {
    await connection.query(
      'SELECT 1',
    )

    return true
  } finally {
    connection.release()
  }
}