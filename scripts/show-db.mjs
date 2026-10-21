import 'dotenv/config'
import fs from 'node:fs'
import path from 'node:path'
import { Client } from 'pg'

const url = new URL(process.env.DATABASE_URL)
let ssl
if (process.env.DB_SSL === 'true') {
  const ca = path.resolve(process.cwd(), process.env.DB_SSL_CA_PATH)
  ssl = { ca: fs.readFileSync(ca, 'utf8'), rejectUnauthorized: true }
}

const client = new Client({
  host: url.hostname,
  port: Number(url.port) || 5432,
  user: decodeURIComponent(url.username),
  password: decodeURIComponent(url.password),
  database: url.pathname.replace(/^\//, ''),
  ssl,
})

await client.connect()
const res = await client.query(
  "SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() ORDER BY table_name",
)
console.table(res.rows)
await client.end()