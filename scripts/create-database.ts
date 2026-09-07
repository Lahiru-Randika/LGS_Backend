import 'dotenv/config'

import fs from 'node:fs'
import path from 'node:path'
import mysql from 'mysql2/promise'

function getSslConfig() {
  const enabled =
    process.env.DB_SSL?.toLowerCase() === 'true'

  if (!enabled) {
    return undefined
  }

  const caPath =
    process.env.DB_SSL_CA_PATH

  if (!caPath) {
    throw new Error(
      'DB_SSL=true but DB_SSL_CA_PATH is not configured',
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
      `Database CA certificate not found: ${absoluteCaPath}`,
    )
  }

  return {
    ca: fs.readFileSync(
      absoluteCaPath,
      'utf8',
    ),

    rejectUnauthorized: true,
  }
}

async function main() {
  const databaseUrl =
    process.env.DATABASE_URL

  if (!databaseUrl) {
    throw new Error(
      'DATABASE_URL is required',
    )
  }

  const url =
    new URL(databaseUrl)

  const databaseName =
    url.pathname.replace(
      /^\//,
      '',
    )

  if (!databaseName) {
    throw new Error(
      'DATABASE_URL must contain a database name',
    )
  }

  /*
    Connect without selecting the database first.

    This allows CREATE DATABASE to work when using
    MySQL servers that permit database creation.
  */
  const connection =
    await mysql.createConnection({
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

      ssl:
        getSslConfig(),

      connectTimeout:
        15000,
    })

  try {
    await connection.query(
      `CREATE DATABASE IF NOT EXISTS \`${databaseName.replace(
        /`/g,
        '``',
      )}\`
       CHARACTER SET utf8mb4
       COLLATE utf8mb4_unicode_ci`,
    )

    console.log(
      `Database "${databaseName}" is ready.`,
    )
  } finally {
    await connection.end()
  }
}

main().catch((error) => {
  console.error(
    'Database creation failed:',
    error,
  )

  process.exit(1)
})