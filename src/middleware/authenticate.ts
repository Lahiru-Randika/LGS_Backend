import type { Request, RequestHandler } from 'express'
import type { RowDataPacket } from '../config/db'
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
  session_expires_at: string | Date
}

interface PermissionRow extends RowDataPacket { code: string }

/* =========================================================
   IN-MEMORY PERFORMANCE CACHES (Fast-Path for Concurrency)
   - Eliminates redundant network DB hops on rapid parallel burst requests
   - Role permissions: 5-minute TTL, bounded
   - Active user session: strictly bounded to MIN(now + 3s, dbExpiresAt)
     Never extends beyond actual DB session expiration.
   - Bounded cache: LRU / size-limited to prevent memory leaks
========================================================= */

const MAX_SESSION_CACHE_SIZE = 2000
const MAX_ROLE_CACHE_SIZE = 50
const FAST_PATH_TTL_MS = 3_000 // 3 seconds: collapses parallel dashboard burst requests while enforcing rapid invalidation

const ROLE_PERMISSIONS_CACHE = new Map<string, { permissions: string[]; expiresAt: number }>()
const SESSION_FAST_PATH_CACHE = new Map<string, { authUser: Express.AuthUser; expiresAt: number }>()

export function invalidateSessionCache(tokenHash?: string) {
  if (tokenHash) {
    SESSION_FAST_PATH_CACHE.delete(tokenHash)
  } else {
    SESSION_FAST_PATH_CACHE.clear()
  }
}

/**
 * Invalidates all cached sessions for a given user ID.
 * Called immediately when an account is disabled/locked, role changes,
 * or password is changed/reset.
 */
export function invalidateUserSessionCache(userId: number) {
  for (const [hash, entry] of SESSION_FAST_PATH_CACHE.entries()) {
    if (entry.authUser.id === userId) {
      SESSION_FAST_PATH_CACHE.delete(hash)
    }
  }
}

export function invalidateRolePermissionsCache(roleCode?: string) {
  if (roleCode) {
    ROLE_PERMISSIONS_CACHE.delete(roleCode)
  } else {
    ROLE_PERMISSIONS_CACHE.clear()
  }
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

  if (ROLE_PERMISSIONS_CACHE.size >= MAX_ROLE_CACHE_SIZE) {
    ROLE_PERMISSIONS_CACHE.clear()
  }

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
      const trimmed = token.trim()
      if (trimmed && trimmed !== 'undefined' && trimmed !== 'null') {
        return trimmed
      }
    }
  }

  const cookieToken = req.cookies?.[env.SESSION_COOKIE_NAME]
  if (cookieToken && typeof cookieToken === 'string') {
    const trimmed = cookieToken.trim()
    if (trimmed && trimmed !== 'undefined' && trimmed !== 'null') {
      return trimmed
    }
  }

  return null
}

export const authenticate: RequestHandler = async (req, _res, next) => {
  try {
    const token = extractToken(req)
    if (!token) return next(unauthorized('No authentication token provided.'))
    const hash = tokenHash(token)

    // Fast-path: Check short-lived process cache
    const now = Date.now()
    const cachedSession = SESSION_FAST_PATH_CACHE.get(hash)
    if (cachedSession) {
      if (cachedSession.expiresAt > now) {
        req.authUser = cachedSession.authUser
        req.authSessionHash = hash
        return next()
      }
      SESSION_FAST_PATH_CACHE.delete(hash)
    }

    const [rows] = await pool.execute<SessionUserRow[]>(
      `SELECT u.id, u.public_id, u.email, u.display_name, r.code AS role_code,
              u.department_id, u.ward_id, s.expires_at AS session_expires_at
         FROM user_sessions s
         JOIN users u ON u.id = s.user_id
         JOIN roles r ON r.id = u.role_id
        WHERE s.token_hash = ?
          AND s.revoked_at IS NULL
          AND s.expires_at > CURRENT_TIMESTAMP
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

    const dbExpiresAt = new Date(row.session_expires_at).getTime()
    if (Number.isNaN(dbExpiresAt) || dbExpiresAt <= now) {
      SESSION_FAST_PATH_CACHE.delete(hash)
      return next(unauthorized('Session has expired.'))
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

    // Cache bounded to MIN(now + FAST_PATH_TTL_MS, actual DB session expiry)
    // Guarantees cache will NEVER outlive the database session!
    const effectiveExpiresAt = Math.min(now + FAST_PATH_TTL_MS, dbExpiresAt)

    // Evict oldest entries if cache exceeds capacity
    if (SESSION_FAST_PATH_CACHE.size >= MAX_SESSION_CACHE_SIZE) {
      const keysToDelete: string[] = []
      for (const [k, v] of SESSION_FAST_PATH_CACHE.entries()) {
        if (v.expiresAt <= now || keysToDelete.length < 200) {
          keysToDelete.push(k)
        }
      }
      keysToDelete.forEach((k) => SESSION_FAST_PATH_CACHE.delete(k))
    }

    SESSION_FAST_PATH_CACHE.set(hash, {
      authUser,
      expiresAt: effectiveExpiresAt,
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
