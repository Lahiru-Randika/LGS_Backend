import type { ErrorRequestHandler, RequestHandler } from 'express'
import multer from 'multer'
import { ZodError } from 'zod'
import { AppError } from '../utils/errors'

export const notFoundHandler: RequestHandler = (req, res) => {
  res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Route not found.' } })
}

export const errorHandler: ErrorRequestHandler = (error, req, res, _next) => {
  req.log?.error?.({ err: error, requestId: req.requestId }, 'request failed')

  if (error instanceof ZodError) {
    return res.status(400).json({
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'The request contains invalid fields.',
        fields: error.flatten(),
      },
    })
  }

  if (error instanceof multer.MulterError) {
    const status = error.code === 'LIMIT_FILE_SIZE' ? 413 : 400
    return res.status(status).json({ success: false, error: { code: error.code, message: error.message } })
  }

  if (error instanceof AppError) {
    return res.status(error.statusCode).json({
      success: false,
      error: { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) },
    })
  }

  const duplicate = (error as any)?.code === 'ER_DUP_ENTRY'
  if (duplicate) {
    return res.status(409).json({ success: false, error: { code: 'CONFLICT', message: 'A record with the same unique value already exists.' } })
  }

  return res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'An unexpected server error occurred.' } })
}
