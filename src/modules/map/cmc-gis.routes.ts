import fs from 'node:fs/promises'
import path from 'node:path'

import { Router } from 'express'

import { optionalAuthenticate } from '../../middleware/authenticate'
import { asyncHandler } from '../../utils/asyncHandler'
import { forbidden, notFound } from '../../utils/errors'
import { ok } from '../../utils/http'
import { routeParam } from '../../utils/routeParam'

const router = Router()

router.use(optionalAuthenticate)

/* =========================================================
   CMC GIS STORAGE

   The GeoJSON files live in the Express project, not in
   the React public folder.
========================================================= */

const CMC_GIS_ROOT = path.resolve(
  process.cwd(),
  'data',
  'gis',
  'cmc',
)

type CmcAccess =
  | 'PUBLIC'
  | 'INTERNAL'

type CmcGeometryType =
  | 'POINT'
  | 'LINE'
  | 'POLYGON'
  | 'MIXED'

type CmcLayerConfig = {
  key: string
  label: string
  file: string
  access: CmcAccess
  geometryType: CmcGeometryType
}

/* =========================================================
   LAYER CATALOG

   PUBLIC:
   Safe map-display layers available to citizens/public users.

   INTERNAL:
   Municipal infrastructure layers. The user must have the
   existing map.internal permission.
========================================================= */

const CMC_LAYERS: Record<string, CmcLayerConfig> = {
  /* -------------------------------------------------------
     PUBLIC
  -------------------------------------------------------- */

  roadSurface: {
    key: 'roadSurface',
    label: 'Road surface',
    file: 'roadSurface.geojson',
    access: 'PUBLIC',
    geometryType: 'POLYGON',
  },

  roadBoundary: {
    key: 'roadBoundary',
    label: 'Road boundaries',
    file: 'roadBoundary.geojson',
    access: 'PUBLIC',
    geometryType: 'LINE',
  },

  roadMarkings: {
    key: 'roadMarkings',
    label: 'Road markings',
    file: 'roadMarkings.geojson',
    access: 'PUBLIC',
    geometryType: 'MIXED',
  },

  laneLines: {
    key: 'laneLines',
    label: 'Lane lines',
    file: 'laneLines.geojson',
    access: 'PUBLIC',
    geometryType: 'LINE',
  },

  stopLines: {
    key: 'stopLines',
    label: 'Stop lines',
    file: 'stopLines.geojson',
    access: 'PUBLIC',
    geometryType: 'LINE',
  },

  crosswalks: {
    key: 'crosswalks',
    label: 'Crosswalks',
    file: 'crosswalks.geojson',
    access: 'PUBLIC',
    geometryType: 'POLYGON',
  },

  trees: {
    key: 'trees',
    label: 'Trees',
    file: 'trees.geojson',
    access: 'PUBLIC',
    geometryType: 'POINT',
  },

  busStops: {
    key: 'busStops',
    label: 'Bus stops',
    file: 'busStops.geojson',
    access: 'PUBLIC',
    geometryType: 'POINT',
  },

  signBoards: {
    key: 'signBoards',
    label: 'Sign boards',
    file: 'signBoards.geojson',
    access: 'PUBLIC',
    geometryType: 'POINT',
  },

  /* -------------------------------------------------------
     INTERNAL MUNICIPAL ASSETS
  -------------------------------------------------------- */

  lightPoles: {
    key: 'lightPoles',
    label: 'Light poles',
    file: 'lightPoles.geojson',
    access: 'INTERNAL',
    geometryType: 'POINT',
  },

  manholes: {
    key: 'manholes',
    label: 'Manholes',
    file: 'manholes.geojson',
    access: 'INTERNAL',
    geometryType: 'POINT',
  },

  stormwaterDrains: {
    key: 'stormwaterDrains',
    label: 'Stormwater drains',
    file: 'stormwaterDrains.geojson',
    access: 'INTERNAL',
    geometryType: 'POINT',
  },

  fireHydrants: {
    key: 'fireHydrants',
    label: 'Fire hydrants',
    file: 'fireHydrants.geojson',
    access: 'INTERNAL',
    geometryType: 'POINT',
  },

  utilityBoxes: {
    key: 'utilityBoxes',
    label: 'Utility boxes',
    file: 'utilityBoxes.geojson',
    access: 'INTERNAL',
    geometryType: 'POINT',
  },

  sewage: {
    key: 'sewage',
    label: 'Sewage assets',
    file: 'sewage.geojson',
    access: 'INTERNAL',
    geometryType: 'POINT',
  },
}

function canReadLayer(
  req: Express.Request,
  config: CmcLayerConfig,
) {
  if (
    config.access ===
    'PUBLIC'
  ) {
    return true
  }

  return Boolean(
    req.authUser?.permissions.includes(
      'map.internal',
    ),
  )
}

/* =========================================================
   GET AVAILABLE CMC LAYERS

   GET /api/v1/map/cmc/layers
========================================================= */

router.get(
  '/layers',
  asyncHandler(
    async (
      req,
      res,
    ) => {
      const layers =
        Object.values(
          CMC_LAYERS,
        )
          .filter(
            (
              config,
            ) =>
              canReadLayer(
                req,
                config,
              ),
          )
          .map(
            (
              config,
            ) => ({
              key:
                config.key,

              label:
                config.label,

              access:
                config.access,

              geometryType:
                config.geometryType,
            }),
          )

      return ok(
        res,
        {
          layers,
        },
      )
    },
  ),
)

/* =========================================================
   GET ONE GEOJSON LAYER

   GET /api/v1/map/cmc/layers/:key
========================================================= */

router.get(
  '/layers/:key',
  asyncHandler(
    async (
      req,
      res,
    ) => {
      /*
        FIX:
        Express route params may be typed as string | string[].

        Resolve the key once before using it as an object index.
      */
      const key =
        routeParam(
          req.params.key,
          'key',
        )

      const config =
        CMC_LAYERS[
          key
        ]

      if (
        !config
      ) {
        throw notFound(
          'CMC GIS layer not found.',
        )
      }

      if (
        !canReadLayer(
          req,
          config,
        )
      ) {
        throw forbidden(
          'This GIS layer is restricted to authorized municipal users.',
        )
      }

      const folder =
        config.access ===
        'PUBLIC'
          ? 'public'
          : 'internal'

      const filePath =
        path.join(
          CMC_GIS_ROOT,
          folder,
          config.file,
        )

      let content:
        string

      try {
        content =
          await fs.readFile(
            filePath,
            'utf8',
          )
      } catch (
        error:
          any
      ) {
        if (
          error?.code ===
          'ENOENT'
        ) {
          throw notFound(
            `CMC GIS data file is missing for layer "${config.key}".`,
          )
        }

        throw error
      }

      /*
        Public map data may be cached.
        Internal infrastructure data should not be stored in a
        shared/public browser cache.
      */
      if (
        config.access ===
        'PUBLIC'
      ) {
        res.setHeader(
          'Cache-Control',
          'public, max-age=3600, stale-while-revalidate=86400',
        )
      } else {
        res.setHeader(
          'Cache-Control',
          'private, no-store',
        )
      }

      res.type(
        'application/geo+json',
      )

      return res
        .status(
          200,
        )
        .send(
          content,
        )
    },
  ),
)

export default router
