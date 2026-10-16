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
    if (!row) return next(unauthorized('Session is invalid or expired.'))

    const [permissionRows] = await pool.execute<PermissionRow[]>(
      `SELECT p.code
         FROM permissions p
         JOIN role_permissions rp ON rp.permission_id = p.id
         JOIN roles r ON r.id = rp.role_id
        WHERE r.code = ?`,
      [row.role_code],
    )

    req.authUser = {
      id: row.id,
      publicId: row.public_id,
      email: row.email,
      displayName: row.display_name,
      role: row.role_code,
      departmentId: row.department_id,
      wardId: row.ward_id,
      permissions: permissionRows.map((p) => p.code),
    }
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
