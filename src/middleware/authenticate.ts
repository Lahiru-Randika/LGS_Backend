import type { Request, RequestHandler } from 'express'
import type { RowDataPacket } from 'mysql2'
import { pool } from '../config/db'
import { env } from '../config/env'
import { tokenHash } from '../utils/crypto'
import { unauthorized } from '../utils/errors'

interface SessionUserRow extends RowDataPacket {
  id: number
  public_id: string
  email: string
  display_name: string
  role_code: string
  department_id: number | null
  ward_id: number | null
}

interface PermissionRow extends RowDataPacket { code: string }

/* =========================================================
   IN-MEMORY PERFORMANCE CACHES (Fast-Path for Concurrency)
   - Eliminates redundant network DB hops on rapid concurrent requests
   - Role permissions: 5-minute TTL (role permissions are static at runtime)
   - Active user session: 10-second sliding TTL (invalidated on logout)
========================================================= */

const ROLE_PERMISSIONS_CACHE = new Map<string, { permissions: string[]; expiresAt: number }>()
const SESSION_FAST_PATH_CACHE = new Map<string, { authUser: Express.AuthUser; expiresAt: number }>()

export function invalidateSessionCache(tokenHash?: string) {
  if (tokenHash) {
    SESSION_FAST_PATH_CACHE.delete(tokenHash)
  } else {
    SESSION_FAST_PATH_CACHE.clear()
  }
}

export function invalidateRolePermissionsCache() {
  ROLE_PERMISSIONS_CACHE.clear()
}

async function getCachedRolePermissions(roleCode: string): Promise<string[]> {
  const now = Date.now()
  const cached = ROLE_PERMISSIONS_CACHE.get(roleCode)
  if (cached && cached.expiresAt > now) {
    return cached.permissions
  }

  const [permissionRows] = await pool.execute<PermissionRow[]>(
    `SELECT p.code
       FROM permissions p
       JOIN role_permissions rp ON rp.permission_id = p.id
       JOIN roles r ON r.id = rp.role_id
      WHERE r.code = ?`,
    [roleCode],
  )

  const permissions = permissionRows.map((p) => p.code)
  ROLE_PERMISSIONS_CACHE.set(roleCode, {
    permissions,
    expiresAt: now + 5 * 60 * 1000, // 5 minutes
  })

  return permissions
}

/**
 * Extracts session token from either:
 * 1. Authorization header: "Bearer <token>"
 * 2. HttpOnly Cookie: env.SESSION_COOKIE_NAME
 *
 * This dual-mode policy ensures resilience against browser cookie restrictions
 * in cross-site setups while retaining full HttpOnly cookie benefits in same-site environments.
 */
export function extractToken(req: Request): string | null {
  const authHeader = req.headers.authorization
  if (authHeader && typeof authHeader === 'string') {
    const [scheme, token] = authHeader.split(/\s+/)
    if (scheme && /^Bearer$/i.test(scheme) && token) {
      return token.trim()
    }
  }

  const cookieToken = req.cookies?.[env.SESSION_COOKIE_NAME]
  if (cookieToken && typeof cookieToken === 'string') {
    return cookieToken.trim()
  }

  return null
}

export const authenticate: RequestHandler = async (req, _res, next) => {
  try {
    const token = extractToken(req)
    if (!token) return next(unauthorized('No authentication token provided.'))
    const hash = tokenHash(token)

    // Fast-path: Check short-lived process cache (10s window for burst requests)
    const now = Date.now()
    const cachedSession = SESSION_FAST_PATH_CACHE.get(hash)
    if (cachedSession && cachedSession.expiresAt > now) {
      req.authUser = cachedSession.authUser
      req.authSessionHash = hash
      return next()
    }

    const [rows] = await pool.execute<SessionUserRow[]>(
      `SELECT u.id, u.public_id, u.email, u.display_name, r.code AS role_code,
              u.department_id, u.ward_id
         FROM user_sessions s
         JOIN users u ON u.id = s.user_id
         JOIN roles r ON r.id = u.role_id
        WHERE s.token_hash = ?
          AND s.revoked_at IS NULL
          AND s.expires_at > UTC_TIMESTAMP()
          AND u.status = 'ACTIVE'
          AND u.deleted_at IS NULL
        LIMIT 1`,
      [hash],
    )

    const row = rows[0]
    if (!row) {
      SESSION_FAST_PATH_CACHE.delete(hash)
      return next(unauthorized('Session is invalid or expired.'))
    }

    const permissions = await getCachedRolePermissions(row.role_code)

    const authUser: Express.AuthUser = {
      id: row.id,
      publicId: row.public_id,
      email: row.email,
      displayName: row.display_name,
      role: row.role_code,
      departmentId: row.department_id,
      wardId: row.ward_id,
      permissions,
    }

    // Cache valid session for 10 seconds to collapse parallel bursts
    SESSION_FAST_PATH_CACHE.set(hash, {
      authUser,
      expiresAt: now + 10_000,
    })

    req.authUser = authUser
    req.authSessionHash = hash
    next()
  } catch (error) {
    next(error)
  }
}

export const optionalAuthenticate: RequestHandler = async (req, res, next) => {
  const token = extractToken(req)
  if (!token) return next()
  return authenticate(req, res, next)
}
