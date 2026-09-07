import crypto from 'node:crypto'
import argon2 from 'argon2'
import { Router } from 'express'
import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import { z } from 'zod'
import { pool, withTransaction } from '../../config/db'
import { env } from '../../config/env'
import { authenticate } from '../../middleware/authenticate'
import { loginRateLimit } from '../../middleware/rateLimits'
import { writeAudit } from '../../services/audit.service'
import { asyncHandler } from '../../utils/asyncHandler'
import { randomToken, tokenHash } from '../../utils/crypto'
import { badRequest, conflict, unauthorized } from '../../utils/errors'
import { created, ok } from '../../utils/http'
import { routeParam } from '../../utils/routeParam'

const router = Router()

interface UserRow extends RowDataPacket {
  id: number
  public_id: string
  first_name: string
  last_name: string
  display_name: string
  email: string
  password_hash: string
  role_code: string
  department_id: number | null
  department_name: string | null
  ward_id: number | null
  status: string
  failed_login_attempts: number
  locked_until: Date | null
}

const registerSchema = z.object({
  firstName: z.string().trim().min(1).max(100),
  lastName: z.string().trim().min(1).max(100),
  email: z.string().email().max(255).transform((v) => v.toLowerCase()),
  password: z.string().min(12).max(200),
})

const loginSchema = z.object({
  email: z.string().email().transform((v) => v.toLowerCase()),
  password: z.string().min(1).max(200),
})

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: z.string().min(12).max(200),
})

const acceptInviteSchema = z.object({
  password: z.string().min(12).max(200),
})

function cookieOptions() {
  return {
    httpOnly: true,
    secure: env.SESSION_COOKIE_SECURE,
    sameSite: 'lax' as const,
    path: '/',
    maxAge: env.SESSION_TTL_HOURS * 60 * 60 * 1000,
  }
}

async function createSession(userId: number, req: any, res: any) {
  const token = randomToken()
  const hash = tokenHash(token)
  await pool.execute(
    `INSERT INTO user_sessions (user_id, token_hash, ip_address, user_agent, expires_at, created_at)
     VALUES (?, ?, ?, ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? HOUR), UTC_TIMESTAMP())`,
    [userId, hash, req.ip ?? null, req.get('user-agent')?.slice(0, 500) ?? null, env.SESSION_TTL_HOURS],
  )
  res.cookie(env.SESSION_COOKIE_NAME, token, cookieOptions())
}

async function permissionsForRole(roleCode: string) {
  const [rows] = await pool.execute<(RowDataPacket & { code: string })[]>(
    `SELECT p.code FROM permissions p
      JOIN role_permissions rp ON rp.permission_id = p.id
      JOIN roles r ON r.id = rp.role_id
     WHERE r.code = ? ORDER BY p.code`,
    [roleCode],
  )
  return rows.map((row) => row.code)
}

router.post('/register', loginRateLimit, asyncHandler(async (req, res) => {
  const input = registerSchema.parse(req.body)
  const [existing] = await pool.execute<RowDataPacket[]>('SELECT id FROM users WHERE email = ? AND deleted_at IS NULL LIMIT 1', [input.email])
  if (existing[0]) throw conflict('An account already exists for this email address.')

  const [roles] = await pool.execute<(RowDataPacket & { id: number })[]>('SELECT id FROM roles WHERE code = ? LIMIT 1', ['CITIZEN'])
  const roleId = roles[0]?.id
  if (!roleId) throw new Error('CITIZEN role is not configured.')

  const passwordHash = await argon2.hash(input.password, { type: argon2.argon2id })
  const publicId = crypto.randomUUID()
  const displayName = `${input.firstName} ${input.lastName}`.trim()

  const [result] = await pool.execute<ResultSetHeader>(
    `INSERT INTO users
      (public_id, first_name, last_name, display_name, email, password_hash, role_id, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'ACTIVE', UTC_TIMESTAMP())`,
    [publicId, input.firstName, input.lastName, displayName, input.email, passwordHash, roleId],
  )

  await writeAudit({
    actorUserId: result.insertId,
    action: 'CITIZEN_REGISTERED',
    entityType: 'USER',
    entityId: publicId,
    ipAddress: req.ip,
    userAgent: req.get('user-agent'),
    requestId: req.requestId,
  })

  return created(res, { user: { id: publicId, name: displayName, email: input.email, role: 'CITIZEN' } })
}))

router.post('/login', loginRateLimit, asyncHandler(async (req, res) => {
  const input = loginSchema.parse(req.body)
  const [rows] = await pool.execute<UserRow[]>(
    `SELECT u.id, u.public_id, u.first_name, u.last_name, u.display_name, u.email, u.password_hash,
            u.department_id, d.name AS department_name, u.ward_id, u.status, u.failed_login_attempts,
            u.locked_until, r.code AS role_code
       FROM users u
       JOIN roles r ON r.id = u.role_id
       LEFT JOIN departments d ON d.id = u.department_id
      WHERE u.email = ? AND u.deleted_at IS NULL
      LIMIT 1`,
    [input.email],
  )
  const user = rows[0]
  const genericError = unauthorized('Email or password is incorrect.')
  if (!user) throw genericError
  if (user.status !== 'ACTIVE') throw unauthorized('This account is not active.')
  if (user.locked_until && new Date(user.locked_until).getTime() > Date.now()) {
    throw unauthorized('This account is temporarily locked. Try again later.')
  }

  const valid = await argon2.verify(user.password_hash, input.password)
  if (!valid) {
    const attempts = user.failed_login_attempts + 1
    const lock = attempts >= env.LOGIN_MAX_ATTEMPTS
    await pool.execute(
      `UPDATE users
          SET failed_login_attempts = ?,
              locked_until = CASE WHEN ? = 1 THEN DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? MINUTE) ELSE NULL END
        WHERE id = ?`,
      [lock ? 0 : attempts, lock ? 1 : 0, env.LOGIN_LOCK_MINUTES, user.id],
    )
    await writeAudit({ actorUserId: user.id, action: 'LOGIN_FAILED', entityType: 'USER', entityId: user.public_id, ipAddress: req.ip, userAgent: req.get('user-agent'), requestId: req.requestId })
    throw genericError
  }

  await withTransaction(async (connection) => {
    await connection.execute('UPDATE users SET failed_login_attempts = 0, locked_until = NULL, last_login_at = UTC_TIMESTAMP() WHERE id = ?', [user.id])
    await writeAudit({ actorUserId: user.id, action: 'LOGIN_SUCCEEDED', entityType: 'USER', entityId: user.public_id, ipAddress: req.ip, userAgent: req.get('user-agent'), requestId: req.requestId }, connection)
  })
  await createSession(user.id, req, res)
  const permissions = await permissionsForRole(user.role_code)

  return ok(res, {
    user: {
      id: user.public_id,
      name: user.display_name,
      email: user.email,
      role: user.role_code,
      department: user.department_id ? { id: user.department_id, name: user.department_name } : null,
      wardId: user.ward_id,
    },
    permissions,
  })
}))

router.get('/me', authenticate, asyncHandler(async (req, res) => {
  const user = req.authUser!
  return ok(res, {
    user: {
      id: user.publicId,
      name: user.displayName,
      email: user.email,
      role: user.role,
      departmentId: user.departmentId,
      wardId: user.wardId,
    },
    permissions: user.permissions,
  })
}))

router.post('/logout', authenticate, asyncHandler(async (req, res) => {
  if (req.authSessionHash) {
    await pool.execute('UPDATE user_sessions SET revoked_at = UTC_TIMESTAMP() WHERE token_hash = ?', [req.authSessionHash])
  }
  res.clearCookie(env.SESSION_COOKIE_NAME, { ...cookieOptions(), maxAge: undefined })
  await writeAudit({ actorUserId: req.authUser!.id, action: 'LOGOUT', entityType: 'USER', entityId: req.authUser!.publicId, ipAddress: req.ip, userAgent: req.get('user-agent'), requestId: req.requestId })
  return ok(res, { loggedOut: true })
}))

router.post('/forgot-password', loginRateLimit, asyncHandler(async (req, res) => {
  const input = z.object({ email: z.string().email().transform((v) => v.toLowerCase()) }).parse(req.body)
  const [rows] = await pool.execute<(RowDataPacket & { id: number; public_id: string })[]>(
    `SELECT id, public_id FROM users WHERE email = ? AND status = 'ACTIVE' AND deleted_at IS NULL LIMIT 1`, [input.email])
  let token: string | undefined
  if (rows[0]) {
    token = randomToken()
    await withTransaction(async (connection) => {
      await connection.execute('UPDATE password_reset_tokens SET used_at = UTC_TIMESTAMP() WHERE user_id = ? AND used_at IS NULL', [rows[0].id])
      await connection.execute(
        `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at, created_at)
         VALUES (?, ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL 30 MINUTE), UTC_TIMESTAMP())`, [rows[0].id, tokenHash(token!)])
      await writeAudit({ actorUserId: rows[0].id, action: 'PASSWORD_RESET_REQUESTED', entityType: 'USER', entityId: rows[0].public_id, ipAddress: req.ip, userAgent: req.get('user-agent'), requestId: req.requestId }, connection)
    })
  }
  // Do not reveal whether an email exists.
  return ok(res, {
    accepted: true,
    ...(env.NODE_ENV !== 'production' && env.EXPOSE_INVITE_TOKEN && token ? { resetToken: token } : {}),
  })
}))

router.post('/reset-password', loginRateLimit, asyncHandler(async (req, res) => {
  const input = z.object({ token: z.string().min(20).max(500), newPassword: z.string().min(12).max(200) }).parse(req.body)
  const hash = tokenHash(input.token)
  const [rows] = await pool.execute<(RowDataPacket & { id: number; user_id: number; public_id: string })[]>(
    `SELECT pr.id, pr.user_id, u.public_id
       FROM password_reset_tokens pr JOIN users u ON u.id = pr.user_id
      WHERE pr.token_hash = ? AND pr.used_at IS NULL AND pr.expires_at > UTC_TIMESTAMP()
        AND u.status = 'ACTIVE' AND u.deleted_at IS NULL LIMIT 1`, [hash])
  const reset = rows[0]
  if (!reset) throw badRequest('Reset token is invalid or expired.')
  const newHash = await argon2.hash(input.newPassword, { type: argon2.argon2id })
  await withTransaction(async (connection) => {
    await connection.execute('UPDATE users SET password_hash = ?, updated_at = UTC_TIMESTAMP() WHERE id = ?', [newHash, reset.user_id])
    await connection.execute('UPDATE password_reset_tokens SET used_at = UTC_TIMESTAMP() WHERE id = ?', [reset.id])
    await connection.execute('UPDATE user_sessions SET revoked_at = UTC_TIMESTAMP() WHERE user_id = ? AND revoked_at IS NULL', [reset.user_id])
    await writeAudit({ actorUserId: reset.user_id, action: 'PASSWORD_RESET_COMPLETED', entityType: 'USER', entityId: reset.public_id, ipAddress: req.ip, userAgent: req.get('user-agent'), requestId: req.requestId }, connection)
  })
  return ok(res, { reset: true, loginRequired: true })
}))

router.post('/change-password', authenticate, asyncHandler(async (req, res) => {
  const input = changePasswordSchema.parse(req.body)
  const [rows] = await pool.execute<(RowDataPacket & { password_hash: string })[]>('SELECT password_hash FROM users WHERE id = ? LIMIT 1', [req.authUser!.id])
  if (!rows[0] || !(await argon2.verify(rows[0].password_hash, input.currentPassword))) throw badRequest('Current password is incorrect.')
  const newHash = await argon2.hash(input.newPassword, { type: argon2.argon2id })
  await withTransaction(async (connection) => {
    await connection.execute('UPDATE users SET password_hash = ?, updated_at = UTC_TIMESTAMP() WHERE id = ?', [newHash, req.authUser!.id])
    await connection.execute('UPDATE user_sessions SET revoked_at = UTC_TIMESTAMP() WHERE user_id = ? AND revoked_at IS NULL', [req.authUser!.id])
    await writeAudit({ actorUserId: req.authUser!.id, action: 'PASSWORD_CHANGED', entityType: 'USER', entityId: req.authUser!.publicId, ipAddress: req.ip, userAgent: req.get('user-agent'), requestId: req.requestId }, connection)
  })
  res.clearCookie(env.SESSION_COOKIE_NAME, { ...cookieOptions(), maxAge: undefined })
  return ok(res, { changed: true, loginRequired: true })
}))

router.post('/invitations/:token/accept', loginRateLimit, asyncHandler(async (req, res) => {
  const input = acceptInviteSchema.parse(req.body)

  /*
    FIX:
    Express route params may be typed as string | string[].
    tokenHash() requires a plain string, so resolve the
    invitation token once before hashing it.
  */
  const token = routeParam(
    req.params.token,
    'token',
  )

  const hash = tokenHash(token)
  const [rows] = await pool.execute<(RowDataPacket & {
    id: number; public_id: string; email: string; first_name: string; last_name: string;
    role_id: number; department_id: number | null; invited_by_user_id: number;
  })[]>(
    `SELECT id, public_id, email, first_name, last_name, role_id, department_id, invited_by_user_id
       FROM government_user_invitations
      WHERE token_hash = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > UTC_TIMESTAMP()
      LIMIT 1`,
    [hash],
  )
  const invite = rows[0]
  if (!invite) throw badRequest('Invitation is invalid or expired.')

  const passwordHash = await argon2.hash(input.password, { type: argon2.argon2id })
  const userPublicId = crypto.randomUUID()
  const displayName = `${invite.first_name} ${invite.last_name}`.trim()

  await withTransaction(async (connection) => {
    const [existing] = await connection.execute<RowDataPacket[]>('SELECT id FROM users WHERE email = ? AND deleted_at IS NULL LIMIT 1', [invite.email])
    if (existing[0]) throw conflict('An account already exists for this email address.')
    const [result] = await connection.execute<ResultSetHeader>(
      `INSERT INTO users
       (public_id, first_name, last_name, display_name, email, password_hash, role_id, department_id, status, email_verified_at, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', UTC_TIMESTAMP(), ?, UTC_TIMESTAMP())`,
      [userPublicId, invite.first_name, invite.last_name, displayName, invite.email, passwordHash, invite.role_id, invite.department_id, invite.invited_by_user_id],
    )
    await connection.execute('UPDATE government_user_invitations SET accepted_at = UTC_TIMESTAMP() WHERE id = ?', [invite.id])
    await writeAudit({ actorUserId: result.insertId, action: 'GOVERNMENT_INVITATION_ACCEPTED', entityType: 'USER', entityId: userPublicId, ipAddress: req.ip, userAgent: req.get('user-agent'), requestId: req.requestId }, connection)
  })

  return created(res, { user: { id: userPublicId, name: displayName, email: invite.email } })
}))

export default router
