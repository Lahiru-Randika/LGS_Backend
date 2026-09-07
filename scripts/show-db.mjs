import 'dotenv/config'

import fs from 'node:fs'
import path from 'node:path'

import mysql from 'mysql2/promise'

const url =
  new URL(
    process.env.DATABASE_URL,
  )

let ssl

if (
  process.env.DB_SSL ===
  'true'
) {
  const ca =
    path.resolve(
      process.cwd(),
      process.env.DB_SSL_CA_PATH,
    )

  ssl = {
    ca:
      fs.readFileSync(
        ca,
      ),
  }
}

const db =
  await mysql.createConnection(
    {
      host:
        url.hostname,

      port:
        Number(
          url.port,
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
        url.pathname.slice(
          1,
        ),

      ssl,
    },
  )

const [
  tables,
] =
  await db.query(
    'SHOW TABLES',
  )

console.table(
  tables,
)

await db.end()