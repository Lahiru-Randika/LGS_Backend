import type { RequestHandler } from 'express'
import { isAllowedOrigin } from '../config/env'
import { forbidden } from '../utils/errors'

const safeMethods = new Set(['GET', 'HEAD', 'OPTIONS'])

export const originGuard: RequestHandler = (req, _res, next) => {
  if (safeMethods.has(req.method)) return next()
  const origin = req.header('origin')
  if (origin) {
    if (!isAllowedOrigin(origin)) return next(forbidden('Request origin is not allowed.'))
    return next()
  }

  // Fallback: If Origin is absent, check Referer header
  const referer = req.header('referer')
  if (referer) {
    try {
      const refererOrigin = new URL(referer).origin
      if (!isAllowedOrigin(refererOrigin)) return next(forbidden('Request referer origin is not allowed.'))
    } catch {
      return next(forbidden('Invalid referer header.'))
    }
  }

  // Neither Origin nor Referer provided (e.g., direct programmatic non-browser API client).
  // Allowed because Bearer/CSRF and session authentication still apply.
  next()
}
