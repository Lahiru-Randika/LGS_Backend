import type { Response } from 'express'

export function ok(res: Response, data: unknown, meta?: unknown) {
  return res.status(200).json({ success: true, data, ...(meta ? { meta } : {}) })
}

export function created(res: Response, data: unknown) {
  return res.status(201).json({ success: true, data })
}
