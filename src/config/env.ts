import 'dotenv/config'
import { z } from 'zod'

const boolFromString = z.string().optional().transform((value) => {
  if (value === undefined) return false
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase())
})

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  LOG_LEVEL: z.string().default('info'),
  DATABASE_URL: z.string().min(1),
  DB_SSL: boolFromString,
  DB_CONNECTION_LIMIT: z.coerce.number().int().min(1).max(100).default(10),
  FRONTEND_ORIGINS: z.string().default('http://localhost:5173'),
  TRUST_PROXY: z.coerce.number().int().min(0).max(2).default(1),
  SESSION_COOKIE_NAME: z.string().min(1).default('lgs_session'),
  SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(168).default(8),
  SESSION_COOKIE_SECURE: boolFromString,
  LOGIN_MAX_ATTEMPTS: z.coerce.number().int().min(3).max(20).default(5),
  LOGIN_LOCK_MINUTES: z.coerce.number().int().min(1).max(1440).default(15),
  UPLOAD_DIR: z.string().default('./uploads'),
  MAX_UPLOAD_BYTES: z.coerce.number().int().min(1024).default(10 * 1024 * 1024),
  MAX_UPLOAD_FILES: z.coerce.number().int().min(1).max(20).default(5),
  VISIGEO_ROOT: z.string().url().default('https://cmc.visigeo.com'),
  VISIGEO_BUILDINGS_URL: z.string().url().default('https://cmc.visigeo.com/vector/buildings.geojson'),
  NOMINATIM_ROOT: z.string().url().default('https://nominatim.openstreetmap.org'),
  OVERPASS_ROOT: z.string().url().default('https://overpass-api.de/api/interpreter'),
  ENABLE_EXTERNAL_GEOCODING: boolFromString,
  BOOTSTRAP_SUPERIOR_NAME: z.string().default('Initial LGS Superior'),
  BOOTSTRAP_SUPERIOR_EMAIL: z.string().email().optional(),
  BOOTSTRAP_SUPERIOR_PASSWORD: z.string().min(16).optional(),
  EXPOSE_INVITE_TOKEN: boolFromString,
})

export const env = envSchema.parse(process.env)

if (env.NODE_ENV === 'production' && !env.SESSION_COOKIE_SECURE) {
  throw new Error('SESSION_COOKIE_SECURE must be true in production.')
}
if (env.NODE_ENV === 'production' && env.EXPOSE_INVITE_TOKEN) {
  throw new Error('EXPOSE_INVITE_TOKEN must be false in production.')
}

export const allowedOrigins = env.FRONTEND_ORIGINS.split(',').map((v) => v.trim()).filter(Boolean)
