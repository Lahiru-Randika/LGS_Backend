import crypto from 'node:crypto'
import type { RowDataPacket } from 'mysql2'
import { pool } from '../config/db'
import { env } from '../config/env'

type PolygonGeometry =
  | { type: 'Polygon'; coordinates: number[][][] }
  | { type: 'MultiPolygon'; coordinates: number[][][][] }

interface CacheRow extends RowDataPacket { response_json: string | object }

function cacheKey(prefix: string, payload: string) {
  return `${prefix}:${crypto.createHash('sha256').update(payload).digest('hex')}`
}

async function cacheGet<T>(key: string): Promise<T | null> {
  const [rows] = await pool.execute<CacheRow[]>(
    'SELECT response_json FROM geocode_cache WHERE cache_key = ? AND expires_at > UTC_TIMESTAMP() LIMIT 1', [key])
  if (!rows[0]) return null
  const value = rows[0].response_json
  return (typeof value === 'string' ? JSON.parse(value) : value) as T
}

async function cachePut(key: string, query: string, provider: string, value: unknown, ttlHours = 168) {
  await pool.execute(
    `INSERT INTO geocode_cache (cache_key, query_text, provider, response_json, expires_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? HOUR), UTC_TIMESTAMP(), UTC_TIMESTAMP())
     ON DUPLICATE KEY UPDATE response_json = VALUES(response_json), expires_at = VALUES(expires_at), updated_at = UTC_TIMESTAMP()`,
    [key, query.slice(0, 1000), provider, JSON.stringify(value), ttlHours],
  )
}

function humanize(value?: string) {
  return value ? value.replaceAll('_', ' ').replace(/\b\w/g, (m) => m.toUpperCase()) : ''
}

function shortAddress(address: Record<string, string | undefined> = {}, displayName = '') {
  const first = [address.house_number, address.road].filter(Boolean).join(' ')
  const area = address.neighbourhood || address.quarter || address.suburb || address.city_district
  const city = address.city || address.town || address.municipality || address.county
  return [first, area, city].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(', ') || displayName
}

export async function searchExternalPlaces(query: string) {
  if (!env.ENABLE_EXTERNAL_GEOCODING) return []
  const normalized = query.trim().toLowerCase()
  const key = cacheKey('nominatim-search', normalized)
  const cached = await cacheGet<any[]>(key)
  if (cached) return cached

  const params = new URLSearchParams({
    format: 'jsonv2', q: query.trim(), limit: '7', addressdetails: '1', namedetails: '1',
    extratags: '1', countrycodes: 'lk', 'accept-language': 'en',
  })
  const response = await fetch(`${env.NOMINATIM_ROOT}/search?${params}`, {
    headers: { Accept: 'application/json', 'User-Agent': 'LGS-Municipal-Platform/1.0' },
    signal: AbortSignal.timeout(6000),
  })
  if (!response.ok) return []
  const data = await response.json() as any[]
  const mapped = data.map((item, index) => ({
    id: item.place_id ? `osm-${item.place_id}` : `osm-${index}`,
    type: 'OSM',
    title: item.name || item.namedetails?.name || item.display_name?.split(',')[0] || 'Mapped place',
    subtitle: shortAddress(item.address, item.display_name || ''),
    latitude: Number(item.lat),
    longitude: Number(item.lon),
    source: 'OSM',
    category: humanize(item.category),
    featureType: humanize(item.type),
  })).filter((item) => Number.isFinite(item.latitude) && Number.isFinite(item.longitude))
  await cachePut(key, query, 'NOMINATIM', mapped, 24)
  return mapped
}

export async function reverseAddress(latitude: number, longitude: number) {
  if (!env.ENABLE_EXTERNAL_GEOCODING) return null
  const query = `${latitude.toFixed(6)},${longitude.toFixed(6)}`
  const key = cacheKey('nominatim-reverse', query)
  const cached = await cacheGet<any>(key)
  if (cached) return cached
  const params = new URLSearchParams({ format: 'jsonv2', lat: String(latitude), lon: String(longitude), zoom: '18', addressdetails: '1', 'accept-language': 'en' })
  const response = await fetch(`${env.NOMINATIM_ROOT}/reverse?${params}`, {
    headers: { Accept: 'application/json', 'User-Agent': 'LGS-Municipal-Platform/1.0' },
    signal: AbortSignal.timeout(6000),
  })
  if (!response.ok) return null
  const item = await response.json() as any
  const result = { shortAddress: shortAddress(item.address, item.display_name || ''), displayName: item.display_name || '' }
  await cachePut(key, query, 'NOMINATIM', result, 168)
  return result
}

function pointInRing(lon: number, lat: number, ring: number[][]) {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]
    const [xj, yj] = ring[j]
    const intersects = yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / ((yj - yi) || Number.EPSILON) + xi
    if (intersects) inside = !inside
  }
  return inside
}

function pointInside(lon: number, lat: number, geometry: PolygonGeometry) {
  const inPolygon = (polygon: number[][][]) => pointInRing(lon, lat, polygon[0]) && !polygon.slice(1).some((hole) => pointInRing(lon, lat, hole))
  return geometry.type === 'Polygon' ? inPolygon(geometry.coordinates) : geometry.coordinates.some(inPolygon)
}

function bbox(geometry: PolygonGeometry) {
  const points: number[][] = []
  if (geometry.type === 'Polygon') geometry.coordinates.forEach((ring) => ring.forEach((p) => points.push(p)))
  else geometry.coordinates.forEach((polygon) => polygon.forEach((ring) => ring.forEach((p) => points.push(p))))
  let south = Infinity, west = Infinity, north = -Infinity, east = -Infinity
  for (const [lon, lat] of points) { south = Math.min(south, lat); west = Math.min(west, lon); north = Math.max(north, lat); east = Math.max(east, lon) }
  const latPad = Math.max(0.00006, (north - south) * 0.25)
  const lonPad = Math.max(0.00006, (east - west) * 0.25)
  return { south: south - latPad, west: west - lonPad, north: north + latPad, east: east + lonPad }
}

function distanceMeters(aLat: number, aLon: number, bLat: number, bLon: number) {
  const r = 6371000; const rad = (v: number) => v * Math.PI / 180
  const dLat = rad(bLat - aLat), dLon = rad(bLon - aLon)
  const a = Math.sin(dLat/2)**2 + Math.cos(rad(aLat))*Math.cos(rad(bLat))*Math.sin(dLon/2)**2
  return r * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a))
}

export async function resolveNameInsidePolygon(geometry: PolygonGeometry, latitude: number, longitude: number) {
  if (!env.ENABLE_EXTERNAL_GEOCODING) return null
  const geometryHash = crypto.createHash('sha256').update(JSON.stringify(geometry)).digest('hex')
  const key = `overpass-polygon:${geometryHash}`
  const cached = await cacheGet<any>(key)
  if (cached) return cached

  const b = bbox(geometry)
  const query = `[out:json][timeout:12];(node["name"](${b.south},${b.west},${b.north},${b.east});way["name"](${b.south},${b.west},${b.north},${b.east});relation["name"](${b.south},${b.west},${b.north},${b.east}););out center tags;`
  const response = await fetch(env.OVERPASS_ROOT, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8', 'User-Agent': 'LGS-Municipal-Platform/1.0' },
    body: new URLSearchParams({ data: query }),
    signal: AbortSignal.timeout(10000),
  })
  if (!response.ok) return null
  const data = await response.json() as any
  const candidates = (data.elements || []).flatMap((element: any) => {
    const tags = element.tags || {}
    const name = String(tags.name || '').trim()
    const lat = element.lat ?? element.center?.lat
    const lon = element.lon ?? element.center?.lon
    if (!name || !Number.isFinite(lat) || !Number.isFinite(lon) || !pointInside(lon, lat, geometry)) return []
    let score = element.type === 'node' ? 40 : element.type === 'way' ? 25 : 5
    if (tags.amenity) score += 30
    if (tags.office) score += 28
    if (tags.tourism || tags.leisure) score += 24
    if (tags.building) score += 15
    if (/department/i.test(name)) score += 28
    if (/faculty/i.test(name)) score += 20
    score -= Math.min(distanceMeters(latitude, longitude, lat, lon) / 2, 40)
    return [{ element, tags, name, lat, lon, score }]
  }).sort((a: any, b: any) => b.score - a.score)

  const best = candidates[0]
  if (!best) {
    await cachePut(key, geometryHash, 'OVERPASS', { matched: false }, 168)
    return { matched: false }
  }
  const address = await reverseAddress(latitude, longitude)
  const result = {
    matched: true,
    name: best.name,
    latitude: best.lat,
    longitude: best.lon,
    osmType: best.element.type,
    osmId: best.element.id,
    featureType: humanize(best.tags.amenity || best.tags.office || best.tags.tourism || best.tags.leisure || best.tags.building || 'mapped place'),
    address: address?.shortAddress || '',
  }
  await cachePut(key, geometryHash, 'OVERPASS', result, 24 * 30)
  return result
}
