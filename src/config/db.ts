import fs from 'node:fs'
import path from 'node:path'
import { Pool as PgPool, type PoolClient, type QueryResult, types } from 'pg'
import { env } from './env'

// Configure pg type parsers to ensure type consistency with application contracts
// INT8 (BIGINT, OID 20) -> return as JavaScript number for IDs and COUNT() aggregations
types.setTypeParser(types.builtins.INT8, (val: string | null) => {
  if (val === null) return null
  const num = Number(val)
  return Number.isSafeInteger(num) ? num : val
})

// DATE (OID 1082) -> return as YYYY-MM-DD string to avoid local timezone drift
types.setTypeParser(types.builtins.DATE, (val: string | null) => val)

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

  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new Error(
      'DATABASE_URL must use postgresql:// or postgres://',
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
    port: Number(url.port) || 5432,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database,
  }
}

/* =========================================================
   DATABASE SSL / TLS (DigitalOcean Managed PostgreSQL)
========================================================= */

export function getDatabaseSslConfig() {
  if (!env.DB_SSL) {
    return undefined
  }

  const configuredPath = process.env.DB_SSL_CA_PATH?.trim()

  if (!configuredPath) {
    throw new Error(
      'DB_SSL=true but DB_SSL_CA_PATH is missing. ' +
        'Example: DB_SSL_CA_PATH=./certs/ca.pem',
    )
  }

  const caPath = path.isAbsolute(configuredPath)
    ? configuredPath
    : path.resolve(process.cwd(), configuredPath)

  if (!fs.existsSync(caPath)) {
    throw new Error(
      `Database CA certificate not found: ${caPath}`,
    )
  }

  const ca = fs.readFileSync(caPath, 'utf8')

  return {
    ca,
    rejectUnauthorized: true,
  }
}

/* =========================================================
   COMPATIBILITY TYPES
========================================================= */

export type RowDataPacket = Record<string, any>

export interface ResultSetHeader {
  insertId: number
  affectedRows: number
}

export interface PoolConnection {
  query<T = any>(sql: string, params?: any[]): Promise<[T, any]>
  execute<T = any>(sql: string, params?: any[]): Promise<[T, any]>
  beginTransaction(): Promise<void>
  commit(): Promise<void>
  rollback(): Promise<void>
  release(): void
}

/* =========================================================
   PLACEHOLDER CONVERSION HELPER
   Safely converts '?' into '$1', '$2', ... outside quoted literals
========================================================= */

export function convertPlaceholders(sql: string): string {
  if (!sql.includes('?')) return sql

  let index = 1
  let inSingleQuote = false
  let inDoubleQuote = false
  let result = ''

  for (let i = 0; i < sql.length; i++) {
    const char = sql[i]
    if (char === "'" && (i === 0 || sql[i - 1] !== '\\')) {
      inSingleQuote = !inSingleQuote
      result += char
    } else if (char === '"' && (i === 0 || sql[i - 1] !== '\\')) {
      inDoubleQuote = !inDoubleQuote
      result += char
    } else if (char === '?' && !inSingleQuote && !inDoubleQuote) {
      result += `$${index++}`
    } else {
      result += char
    }
  }

  return result
}

function processQueryResult<T>(res: QueryResult<any>): [T, any] {
  const rows = res.rows as any
  const firstRow = rows[0]
  const insertId = firstRow?.id !== undefined ? Number(firstRow.id) : 0
  const affectedRows = res.rowCount ?? 0

  // Attach ResultSetHeader properties to the rows array for callers destructuring [result]
  rows.insertId = insertId
  rows.affectedRows = affectedRows

  return [rows as T, res]
}

/* =========================================================
   DATABASE CONNECTION POOL
========================================================= */

const db = parseDatabaseUrl()

export const pgPool: PgPool = new PgPool({
  host: db.host,
  port: db.port,
  user: db.user,
  password: db.password,
  database: db.database,
  max: env.DB_CONNECTION_LIMIT,
  idleTimeoutMillis: 60_000,
  connectionTimeoutMillis: 15_000,
  ssl: getDatabaseSslConfig(),
})

function wrapClient(client: PoolClient): PoolConnection {
  return {
    async query<T = any>(sql: string, params?: any[]): Promise<[T, any]> {
      const convertedSql = convertPlaceholders(sql)
      const res = await client.query(convertedSql, params)
      return processQueryResult<T>(res)
    },
    async execute<T = any>(sql: string, params?: any[]): Promise<[T, any]> {
      const convertedSql = convertPlaceholders(sql)
      const res = await client.query(convertedSql, params)
      return processQueryResult<T>(res)
    },
    async beginTransaction(): Promise<void> {
      await client.query('BEGIN')
    },
    async commit(): Promise<void> {
      await client.query('COMMIT')
    },
    async rollback(): Promise<void> {
      await client.query('ROLLBACK')
    },
    release(): void {
      client.release()
    },
  }
}

export const pool = {
  async query<T = any>(sql: string, params?: any[]): Promise<[T, any]> {
    const convertedSql = convertPlaceholders(sql)
    const res = await pgPool.query(convertedSql, params)
    return processQueryResult<T>(res)
  },

  async execute<T = any>(sql: string, params?: any[]): Promise<[T, any]> {
    const convertedSql = convertPlaceholders(sql)
    const res = await pgPool.query(convertedSql, params)
    return processQueryResult<T>(res)
  },

  async getConnection(): Promise<PoolConnection> {
    const client = await pgPool.connect()
    return wrapClient(client)
  },

  async connect(): Promise<PoolConnection> {
    const client = await pgPool.connect()
    return wrapClient(client)
  },

  async end(): Promise<void> {
    await pgPool.end()
  },
}

/* =========================================================
   TRANSACTION HELPER
========================================================= */

export async function withTransaction<T>(
  work: (connection: PoolConnection) => Promise<T>,
): Promise<T> {
  const client = await pgPool.connect()
  const connection = wrapClient(client)

  try {
    await connection.beginTransaction()
    const result = await work(connection)
    await connection.commit()
    return result
  } catch (error) {
    try {
      await connection.rollback()
    } catch {
      // Keep original error
    }
    throw error
  } finally {
    connection.release()
  }
}

/* =========================================================
   DATABASE HEALTH CHECK
========================================================= */

export async function dbPing(): Promise<boolean> {
  try {
    const [rows] = await pool.query<RowDataPacket[]>('SELECT 1 AS ok')
    return Number(rows[0]?.ok) === 1
  } catch (error) {
    console.error('Database health check failed:', error)
    return false
  }
}

/* =========================================================
   LIGHTWEIGHT POOL OBSERVABILITY
========================================================= */

export function getPoolStats() {
  return {
    totalConnections: pgPool.totalCount,
    freeConnections: pgPool.idleCount,
    queueLength: pgPool.waitingCount,
    connectionLimit: env.DB_CONNECTION_LIMIT,
  }
}