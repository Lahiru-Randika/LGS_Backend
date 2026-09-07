import type { RequestHandler } from 'express'
import { requestId } from '../utils/crypto'

export const requestContext: RequestHandler = (req, res, next) => {
  req.requestId = req.header('x-request-id')?.slice(0, 100) || requestId()
  res.setHeader('x-request-id', req.requestId)
  next()
}
