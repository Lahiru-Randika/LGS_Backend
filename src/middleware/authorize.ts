import type { RequestHandler } from 'express'
import { forbidden, unauthorized } from '../utils/errors'

export function requirePermission(...permissions: string[]): RequestHandler {
  return (req, _res, next) => {
    if (!req.authUser) return next(unauthorized())
    const has = permissions.every((permission) => req.authUser!.permissions.includes(permission))
    if (!has) return next(forbidden())
    next()
  }
}

export function requireAnyPermission(...permissions: string[]): RequestHandler {
  return (req, _res, next) => {
    if (!req.authUser) return next(unauthorized())
    const has = permissions.some((permission) => req.authUser!.permissions.includes(permission))
    if (!has) return next(forbidden())
    next()
  }
}
