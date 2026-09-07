import express from 'express'
import cookieParser from 'cookie-parser'
import cors from 'cors'
import helmet from 'helmet'
import pinoHttp from 'pino-http'
import pino from 'pino'

import {
  allowedOrigins,
  env,
} from './config/env'

import {
  dbPing,
} from './config/db'

import {
  errorHandler,
  notFoundHandler,
} from './middleware/errorHandler'

import {
  generalRateLimit,
} from './middleware/rateLimits'

import {
  requestContext,
} from './middleware/requestContext'

import {
  originGuard,
} from './middleware/originGuard'

import authRoutes from './modules/auth/auth.routes'
import userRoutes from './modules/users/users.routes'
import departmentRoutes from './modules/departments/departments.routes'
import requestRoutes from './modules/requests/requests.routes'
import inspectionRoutes from './modules/inspections/inspections.routes'
import approvalRoutes from './modules/approvals/approvals.routes'
import buildingRoutes from './modules/buildings/buildings.routes'
import buildingResolutionRoutes from './modules/map/building-resolution.routes'

import mapRoutes, {
  gisProxyRouter,
} from './modules/map/map.routes'

/*
  NEW:
  Local CMC master-folder GIS layers.
*/
import cmcGisRoutes from './modules/map/cmc-gis.routes'

import notificationRoutes from './modules/notifications/notifications.routes'
import dashboardRoutes from './modules/dashboard/dashboard.routes'
import publicRoutes from './modules/public/public.routes'
import taxRoutes from './modules/tax/tax.routes'
import analyticsRoutes from './modules/analytics/analytics.routes'
import contentRoutes from './modules/content/content.routes'
import auditRoutes from './modules/audit/audit.routes'

import {
  asyncHandler,
} from './utils/asyncHandler'

const logger =
  pino({
    level:
      env.LOG_LEVEL,
  })

export const app =
  express()

app.disable(
  'x-powered-by',
)

app.set(
  'trust proxy',
  env.TRUST_PROXY,
)

app.use(
  pinoHttp({
    logger,

    redact: [
      'req.headers.cookie',
      'req.headers.authorization',
      'req.body.password',
      'req.body.currentPassword',
      'req.body.newPassword',
    ],
  }),
)

app.use(
  requestContext,
)

app.use(
  helmet({
    crossOriginResourcePolicy: {
      policy:
        'cross-origin',
    },
  }),
)

app.use(
  cors({
    credentials:
      true,

    origin(
      origin,
      callback,
    ) {
      if (
        !origin ||
        allowedOrigins.includes(
          origin,
        )
      ) {
        return callback(
          null,
          true,
        )
      }

      return callback(
        new Error(
          'Origin not allowed by CORS',
        ),
      )
    },

    methods: [
      'GET',
      'POST',
      'PATCH',
      'DELETE',
      'OPTIONS',
    ],

    allowedHeaders: [
      'Content-Type',
      'X-Request-ID',
    ],
  }),
)

app.use(
  generalRateLimit,
)

app.use(
  cookieParser(),
)

app.use(
  express.json({
    limit:
      '1mb',
  }),
)

app.use(
  express.urlencoded({
    extended:
      false,

    limit:
      '128kb',
  }),
)

app.use(
  originGuard,
)

app.use(
  '/api/v1/map',
  buildingResolutionRoutes,
)

/* =========================================================
   HEALTH
========================================================= */

app.get(
  '/health',

  asyncHandler(
    async (
      _req,
      res,
    ) => {
      const database =
        await dbPing()

      res
        .status(
          database
            ? 200
            : 503,
        )
        .json({
          success:
            database,

          data: {
            service:
              'lgs-secure-api',

            database,

            time:
              new Date()
                .toISOString(),
          },
        })
    },
  ),
)

/* =========================================================
   EXISTING GIS PROXY
========================================================= */

app.use(
  '/gis',
  gisProxyRouter,
)

/* =========================================================
   API
========================================================= */

const api =
  express.Router()

api.use(
  (
    _req,
    res,
    next,
  ) => {
    res.setHeader(
      'Cache-Control',
      'no-store',
    )

    next()
  },
)

api.use(
  '/auth',
  authRoutes,
)

api.use('/map/cmc', cmcGisRoutes)

api.use(
  '/users',
  userRoutes,
)

api.use(
  '/departments',
  departmentRoutes,
)

api.use(
  '/requests',
  requestRoutes,
)

api.use(
  '/',
  inspectionRoutes,
)

api.use(
  '/',
  approvalRoutes,
)

api.use(
  '/buildings',
  buildingRoutes,
)

/*
  NEW.

  Keep this before the existing /map router.
*/
api.use(
  '/map/cmc',
  cmcGisRoutes,
)

/*
  EXISTING MAP ROUTER.
*/
api.use(
  '/map',
  mapRoutes,
)

api.use(
  '/notifications',
  notificationRoutes,
)

api.use(
  '/dashboard',
  dashboardRoutes,
)

api.use(
  '/public',
  publicRoutes,
)

api.use(
  '/tax',
  taxRoutes,
)

api.use(
  '/analytics',
  analyticsRoutes,
)

api.use(
  '/',
  contentRoutes,
)

api.use(
  '/audit',
  auditRoutes,
)

app.use(
  '/api/v1',
  api,
)

app.use(
  notFoundHandler,
)

app.use(
  errorHandler,
)