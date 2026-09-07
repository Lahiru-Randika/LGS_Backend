import type { RequestHandler } from 'express'
import { allowedOrigins } from '../config/env'
import { forbidden } from '../utils/errors'

const safeMethods = new Set(['GET', 'HEAD', 'OPTIONS'])

export const originGuard: RequestHandler = (req, _res, next) => {
  if (safeMethods.has(req.method)) return next()
  const origin = req.header('origin')
  if (!origin) return next() // supports server-to-server clients; auth/RBAC still applies
  if (!allowedOrigins.includes(origin)) return next(forbidden('Request origin is not allowed.'))
  next()
}
