import crypto from 'node:crypto'
import { Router } from 'express'
import type { RowDataPacket } from 'mysql2'
import { z } from 'zod'
import { pool, withTransaction } from '../../config/db'
import { env } from '../../config/env'
import { authenticate, optionalAuthenticate } from '../../middleware/authenticate'
import { requirePermission } from '../../middleware/authorize'
import { writeAudit } from '../../services/audit.service'
import { resolveNameInsidePolygon, searchExternalPlaces } from '../../services/geocoding.service'
import { asyncHandler } from '../../utils/asyncHandler'
import { badRequest, notFound } from '../../utils/errors'
import { ok } from '../../utils/http'

const router = Router()

function geometryCenter(geometry: any): { latitude: number; longitude: number } | null {
  const pts: number[][] = []
  if (geometry?.type === 'Polygon') geometry.coordinates?.forEach((ring: number[][]) => ring.forEach((p) => pts.push(p)))
  else if (geometry?.type === 'MultiPolygon') geometry.coordinates?.forEach((poly: number[][][]) => poly.forEach((ring) => ring.forEach((p) => pts.push(p))))
  if (!pts.length) return null
  let south = Infinity, west = Infinity, north = -Infinity, east = -Infinity
  for (const [lon, lat] of pts) { south = Math.min(south, lat); west = Math.min(west, lon); north = Math.max(north, lat); east = Math.max(east, lon) }
  return { latitude: (south + north) / 2, longitude: (west + east) / 2 }
}

router.get('/config', optionalAuthenticate, asyncHandler(async (_req, res) => {
  const [sources] = await pool.execute<RowDataPacket[]>(
    `SELECT code, label, source_type AS sourceType, provider, proxy_url AS url, min_zoom AS minZoom, max_zoom AS maxZoom,
            bounds_north AS boundsNorth, bounds_south AS boundsSouth, bounds_east AS boundsEast, bounds_west AS boundsWest
       FROM map_sources WHERE enabled = 1 ORDER BY sort_order, id`)
  return ok(res, { center: { latitude: 6.90734, longitude: 79.86237 }, defaultZoom: 16, layers: sources })
}))

router.get('/buildings.geojson', optionalAuthenticate, asyncHandler(async (_req, res) => {
  const [rows] = await pool.execute<(RowDataPacket & { external_feature_id: string | null; building_code: string; name: string | null; resolved_name: string | null; geometry_json: any })[]>(
    `SELECT external_feature_id, building_code, name, resolved_name, geometry_json
       FROM buildings WHERE active = 1 AND deleted_at IS NULL AND geometry_json IS NOT NULL`)
  if (rows.length) {
    return res.json({ type: 'FeatureCollection', features: rows.map((row) => ({
      type: 'Feature', id: row.external_feature_id ?? row.building_code,
      properties: { id: row.external_feature_id, buildingCode: row.building_code, name: row.resolved_name || row.name || undefined },
      geometry: typeof row.geometry_json === 'string' ? JSON.parse(row.geometry_json) : row.geometry_json,
    })) })
  }

  const upstream = await fetch(env.VISIGEO_BUILDINGS_URL, { headers: { Accept: 'application/geo+json,application/json' }, signal: AbortSignal.timeout(10000) })
  if (!upstream.ok) throw new Error(`Visigeo buildings returned ${upstream.status}`)
  res.setHeader('Cache-Control', 'public, max-age=300')
  return res.status(200).send(await upstream.text())
}))

router.get('/search', optionalAuthenticate, asyncHandler(async (req, res) => {
  const q = z.object({ q: z.string().trim().min(2).max(200) }).parse(req.query)
  const like = `%${q.q}%`
  const [buildings] = await pool.execute<RowDataPacket[]>(
    `SELECT DISTINCT b.building_code AS id, 'BUILDING' AS type,
            COALESCE(b.resolved_name, b.name, ba.name, b.building_code) AS title,
            COALESCE(b.address, '') AS subtitle, b.latitude, b.longitude, 'LGS' AS source
       FROM buildings b LEFT JOIN building_aliases ba ON ba.building_id = b.id
      WHERE b.active = 1 AND b.deleted_at IS NULL
        AND (b.building_code LIKE ? OR b.name LIKE ? OR b.resolved_name LIKE ? OR b.address LIKE ? OR ba.name LIKE ?)
      ORDER BY (COALESCE(b.resolved_name,b.name,ba.name,b.building_code) = ?) DESC,
               COALESCE(b.resolved_name,b.name,ba.name,b.building_code)
      LIMIT 10`, [like, like, like, like, like, q.q])
  const external = buildings.length >= 7 ? [] : await searchExternalPlaces(q.q)
  return ok(res, [...buildings, ...external].slice(0, 12))
}))

router.post('/buildings/:featureId/resolve', authenticate, requirePermission('building.manage'), asyncHandler(async (req, res) => {
  const [rows] = await pool.execute<(RowDataPacket & { id: number; building_code: string; latitude: string | null; longitude: string | null; geometry_json: any; resolved_name: string | null })[]>(
    `SELECT id, building_code, latitude, longitude, geometry_json, resolved_name
       FROM buildings WHERE external_feature_id = ? AND active = 1 AND deleted_at IS NULL LIMIT 1`, [req.params.featureId])
  const building = rows[0]
  if (!building) throw notFound('Building has not been synchronized into the LGS database.')
  if (building.resolved_name) return ok(res, { name: building.resolved_name, cached: true, buildingCode: building.building_code })
  if (!building.geometry_json || building.latitude == null || building.longitude == null) throw badRequest('Building does not contain enough geometry to resolve safely.')
  const geometry = typeof building.geometry_json === 'string' ? JSON.parse(building.geometry_json) : building.geometry_json
  const match = await resolveNameInsidePolygon(geometry, Number(building.latitude), Number(building.longitude))
  if (!match?.matched) return ok(res, { matched: false, buildingCode: building.building_code })

  await withTransaction(async (connection) => {
    await connection.execute(
      `UPDATE buildings SET resolved_name = ?, address = COALESCE(address, ?), name_match_status = 'POLYGON_VERIFIED', osm_type = ?, osm_id = ?, updated_at = UTC_TIMESTAMP() WHERE id = ?`,
      [match.name, match.address || null, match.osmType || null, match.osmId || null, building.id])
    await connection.execute(
      `INSERT IGNORE INTO building_aliases (building_id, name, source, confidence, is_primary, created_at)
       VALUES (?, ?, 'OSM', 'POLYGON_VERIFIED', 1, UTC_TIMESTAMP())`, [building.id, match.name])
    await writeAudit({ actorUserId: req.authUser!.id, action: 'BUILDING_NAME_RESOLVED', entityType: 'BUILDING', entityId: building.building_code, afterData: match, ipAddress: req.ip, userAgent: req.get('user-agent'), requestId: req.requestId }, connection)
  })
  return ok(res, { ...match, buildingCode: building.building_code, cached: false })
}))

router.post('/admin/gis/buildings/sync', authenticate, requirePermission('gis.manage'), asyncHandler(async (req, res) => {
  const upstream = await fetch(env.VISIGEO_BUILDINGS_URL, { headers: { Accept: 'application/geo+json,application/json' }, signal: AbortSignal.timeout(15000) })
  if (!upstream.ok) throw new Error(`Visigeo buildings returned ${upstream.status}`)
  const data = await upstream.json() as any
  if (data?.type !== 'FeatureCollection' || !Array.isArray(data.features)) throw badRequest('Upstream building source is not a GeoJSON FeatureCollection.')
  let inserted = 0, updated = 0, skipped = 0

  await withTransaction(async (connection) => {
    for (const feature of data.features) {
      const props = feature?.properties || {}
      const featureId = String(props.id ?? props.ID ?? props.fid ?? props.FID ?? feature?.id ?? '').trim()
      if (!featureId || !feature?.geometry || !['Polygon', 'MultiPolygon'].includes(feature.geometry.type)) { skipped++; continue }
      const center = geometryCenter(feature.geometry)
      if (!center) { skipped++; continue }
      const code = `LGS-BLD-${featureId.padStart(6, '0')}`
      const name = String(props.name ?? props.Name ?? props.NAME ?? '').trim() || null
      const address = String(props.address ?? props.Address ?? '').trim() || null
      const [existing] = await connection.execute<(RowDataPacket & { id: number })[]>('SELECT id FROM buildings WHERE external_source = ? AND external_feature_id = ? LIMIT 1', ['CMC_VISIGEO', featureId])
      if (existing[0]) {
        await connection.execute(
          `UPDATE buildings SET geometry_json = ?, latitude = ?, longitude = ?, name = COALESCE(name, ?), address = COALESCE(address, ?), active = 1, updated_at = UTC_TIMESTAMP() WHERE id = ?`,
          [JSON.stringify(feature.geometry), center.latitude, center.longitude, name, address, existing[0].id])
        updated++
      } else {
        await connection.execute(
          `INSERT INTO buildings
           (building_code, external_source, external_feature_id, name, address, latitude, longitude, geometry_json, active, created_at)
           VALUES (?, 'CMC_VISIGEO', ?, ?, ?, ?, ?, ?, 1, UTC_TIMESTAMP())`,
          [code, featureId, name, address, center.latitude, center.longitude, JSON.stringify(feature.geometry)])
        inserted++
      }
    }
    await writeAudit({ actorUserId: req.authUser!.id, action: 'GIS_BUILDINGS_SYNCED', entityType: 'GIS', entityId: 'CMC_VISIGEO', afterData: { inserted, updated, skipped }, ipAddress: req.ip, userAgent: req.get('user-agent'), requestId: req.requestId }, connection)
  })
  return ok(res, { inserted, updated, skipped, total: data.features.length })
}))

router.get('/requests.geojson', authenticate, asyncHandler(async (req, res) => {
  const q = z.object({
    west: z.coerce.number().min(-180).max(180).optional(),
    south: z.coerce.number().min(-90).max(90).optional(),
    east: z.coerce.number().min(-180).max(180).optional(),
    north: z.coerce.number().min(-90).max(90).optional(),
  }).parse(req.query)

  if (!req.authUser!.permissions.includes('map.internal')) return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Internal request markers are not available to this account.' } })
  const where = ['sr.deleted_at IS NULL', 'sr.latitude IS NOT NULL', 'sr.longitude IS NOT NULL']
  const params: any[] = []
  if (req.authUser!.permissions.includes('request.all.read')) {
    // no extra scope
  } else if (req.authUser!.permissions.includes('request.assigned.read')) {
    where.push('sr.assigned_to_user_id = ?'); params.push(req.authUser!.id)
  } else {
    where.push('1=0')
  }
  if ([q.west,q.south,q.east,q.north].every((v) => v !== undefined)) {
    where.push('sr.longitude BETWEEN ? AND ? AND sr.latitude BETWEEN ? AND ?')
    params.push(q.west!, q.east!, q.south!, q.north!)
  }
  const [rows] = await pool.execute<(RowDataPacket & {
    request_code: string; type: string; status: string; priority: string; title: string; latitude: string; longitude: string;
  })[]>(
    `SELECT sr.request_code, sr.type, sr.status, sr.priority, sr.title, sr.latitude, sr.longitude
       FROM service_requests sr WHERE ${where.join(' AND ')} ORDER BY sr.created_at DESC LIMIT 2000`, params)
  return res.json({
    type: 'FeatureCollection',
    features: rows.map((row) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [Number(row.longitude), Number(row.latitude)] },
      properties: { requestCode: row.request_code, type: row.type, status: row.status, priority: row.priority, title: row.title },
    })),
  })
}))

export default router

export const gisProxyRouter = Router()
gisProxyRouter.get('/cmc/rgb/:z/:x/:y.png', asyncHandler(async (req, res) => {
  const coords = z.object({ z: z.coerce.number().int().min(0).max(22), x: z.coerce.number().int().min(0), y: z.coerce.number().int().min(0) }).parse(req.params)
  const upstream = await fetch(`${env.VISIGEO_ROOT}/rgb/${coords.z}/${coords.x}/${coords.y}.png`, { signal: AbortSignal.timeout(10000) })
  if (upstream.status === 404) return res.status(404).end()
  if (!upstream.ok) throw new Error(`Visigeo tile returned ${upstream.status}`)
  const buffer = Buffer.from(await upstream.arrayBuffer())
  res.setHeader('Content-Type', upstream.headers.get('content-type') || 'image/png')
  res.setHeader('Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800')
  return res.status(200).send(buffer)
}))
