import { app } from './app'
import { env } from './config/env'
import { pool } from './config/db'

const server = app.listen(env.PORT, () => {
  console.log(`LGS API listening on http://localhost:${env.PORT}`)
  console.log(`Health: http://localhost:${env.PORT}/health`)
  console.log(`API root: http://localhost:${env.PORT}/api/v1`)
})

async function shutdown(signal: string) {
  console.log(`${signal} received; shutting down.`)
  server.close(async () => {
    await pool.end()
    process.exit(0)
  })
  const forceExitTimer = setTimeout(() => process.exit(1), 10_000)
  if (typeof (forceExitTimer as any).unref === 'function') {
    ;(forceExitTimer as any).unref()
  }
}

process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))
