import fs from 'node:fs/promises'
import path from 'node:path'

import { Router } from 'express'

import { optionalAuthenticate } from '../../middleware/authenticate'
import { asyncHandler } from '../../utils/asyncHandler'
import { forbidden, notFound } from '../../utils/errors'
import { routeParam } from '../../utils/routeParam'

const router = Router()

router.use(optionalAuthenticate)

/* =========================================================
   CMC GIS STORAGE
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
========================================================= */

const CMC_LAYERS: Record<string, CmcLayerConfig> = {
  /* -------------------------------------------------------
     PUBLIC
  -------------------------------------------------------- */

  landParcels: {
    key: 'landParcels',
    label: 'Land parcels',
    file: 'landParcels.geojson',
    access: 'PUBLIC',
    geometryType: 'POLYGON',
  },

  roadSurface: {
    key: 'roadSurface',
    label: 'Road surface',
    file: 'roadSurface.geojson',
    access: 'PUBLIC',
    geometryType: 'POLYGON',
  },

  roadFeatures: {
    key: 'roadFeatures',
    label: 'Road features',
    file: 'roadFeatures.geojson',
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

  roadSideLines: {
    key: 'roadSideLines',
    label: 'Road side lines',
    file: 'roadSideLines.geojson',
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

  forbidLines: {
    key: 'forbidLines',
    label: 'Forbidden lines',
    file: 'forbidLines.geojson',
    access: 'PUBLIC',
    geometryType: 'LINE',
  },

  planarFacilities: {
    key: 'planarFacilities',
    label: 'Planar facilities',
    file: 'planarFacilities.geojson',
    access: 'PUBLIC',
    geometryType: 'POLYGON',
  },

  trafficSigns: {
    key: 'trafficSigns',
    label: 'Traffic signs',
    file: 'trafficSigns.geojson',
    access: 'PUBLIC',
    geometryType: 'POINT',
  },

  signalLightPosts: {
    key: 'signalLightPosts',
    label: 'Signal light posts',
    file: 'signalLightPosts.geojson',
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

  busStopAreas: {
    key: 'busStopAreas',
    label: 'Bus stop areas',
    file: 'busStopAreas.geojson',
    access: 'PUBLIC',
    geometryType: 'POLYGON',
  },

  roadNameBoards: {
    key: 'roadNameBoards',
    label: 'Road name boards',
    file: 'roadNameBoards.geojson',
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

  billboards: {
    key: 'billboards',
    label: 'Billboards / digital screens',
    file: 'billboards.geojson',
    access: 'PUBLIC',
    geometryType: 'POINT',
  },

  bridges: {
    key: 'bridges',
    label: 'Bridges',
    file: 'bridges.geojson',
    access: 'PUBLIC',
    geometryType: 'POINT',
  },

  benches: {
    key: 'benches',
    label: 'Benches',
    file: 'benches.geojson',
    access: 'PUBLIC',
    geometryType: 'POINT',
  },

  structures: {
    key: 'structures',
    label: 'Statues / structures',
    file: 'structures.geojson',
    access: 'PUBLIC',
    geometryType: 'POINT',
  },

  trees: {
    key: 'trees',
    label: 'Trees',
    file: 'trees.geojson',
    access: 'PUBLIC',
    geometryType: 'POINT',
  },

  extractedTrees: {
    key: 'extractedTrees',
    label: 'Extracted trees',
    file: 'extractedTrees.geojson',
    access: 'PUBLIC',
    geometryType: 'POINT',
  },

  fences: {
    key: 'fences',
    label: 'Fence lines',
    file: 'fences.geojson',
    access: 'PUBLIC',
    geometryType: 'LINE',
  },

  /* -------------------------------------------------------
     INTERNAL MUNICIPAL ASSETS
  -------------------------------------------------------- */

  poles: {
    key: 'poles',
    label: 'Extracted poles',
    file: 'poles.geojson',
    access: 'INTERNAL',
    geometryType: 'POINT',
  },

  lightPoles: {
    key: 'lightPoles',
    label: 'Light poles',
    file: 'lightPoles.geojson',
    access: 'INTERNAL',
    geometryType: 'POINT',
  },

  telephoneElectricPosts: {
    key: 'telephoneElectricPosts',
    label: 'Telephone / electric posts',
    file: 'telephoneElectricPosts.geojson',
    access: 'INTERNAL',
    geometryType: 'POINT',
  },

  fenceSurveyPoints: {
    key: 'fenceSurveyPoints',
    label: 'Fence survey points',
    file: 'fenceSurveyPoints.geojson',
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

  pits: {
    key: 'pits',
    label: 'Pits',
    file: 'pits.geojson',
    access: 'INTERNAL',
    geometryType: 'POINT',
  },

  waterMeters: {
    key: 'waterMeters',
    label: 'Water meters',
    file: 'waterMeters.geojson',
    access: 'INTERNAL',
    geometryType: 'POINT',
  },

  waterOutlets: {
    key: 'waterOutlets',
    label: 'Water outlets',
    file: 'waterOutlets.geojson',
    access: 'INTERNAL',
    geometryType: 'POINT',
  },

  waterValves: {
    key: 'waterValves',
    label: 'Water valves',
    file: 'waterValves.geojson',
    access: 'INTERNAL',
    geometryType: 'POINT',
  },

  policeSecurityHuts: {
    key: 'policeSecurityHuts',
    label: 'Police / security huts',
    file: 'policeSecurityHuts.geojson',
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

      return res
        .status(
          200,
        )
        .json({
          layers,
        })
    },
  ),
)

/* =========================================================
   GET ONE GEOJSON LAYER
========================================================= */

router.get(
  '/layers/:key',
  asyncHandler(
    async (
      req,
      res,
    ) => {
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
