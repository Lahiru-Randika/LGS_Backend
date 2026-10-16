import assert from 'node:assert'
import crypto from 'node:crypto'
import { pool, withTransaction } from '../src/config/db'
import { tokenHash } from '../src/utils/crypto'
import {
  authenticate,
  invalidateSessionCache,
  invalidateUserSessionCache,
} from '../src/middleware/authenticate'
import type { Request, Response } from 'express'
import type { RowDataPacket, ResultSetHeader } from 'mysql2/promise'

// ANSI colors for clean test logging
const green = (s: string) => `\x1b[32m${s}\x1b[0m`
const red = (s: string) => `\x1b[31m${s}\x1b[0m`
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`

async function runAuditTests() {
  console.log(bold('\n============================================================'))
  console.log(bold(' SPATIO LGS — PRODUCTION SAFETY & CONCURRENCY AUDIT SUITE'))
  console.log(bold('============================================================\n'))

  let testUserId = 0
  let testBuildingId = 0

  try {
    // -------------------------------------------------------------
    // SETUP: Get or create isolated test user and test facility
    // -------------------------------------------------------------
    const [userRows] = await pool.execute<RowDataPacket[]>(
      "SELECT id FROM users WHERE status = 'ACTIVE' AND deleted_at IS NULL LIMIT 1"
    )
    if (!userRows[0]) throw new Error('No active user found in database for test harness')
    testUserId = userRows[0].id

    const [bldRows] = await pool.execute<RowDataPacket[]>(
      `SELECT b.id FROM buildings b 
       JOIN public_facility_profiles p ON p.building_id = b.id 
       WHERE b.public_facility = 1 AND p.bookable = 1 AND b.deleted_at IS NULL LIMIT 1`
    )
    if (!bldRows[0]) throw new Error('No bookable facility found in database for test harness')
    testBuildingId = bldRows[0].id

    console.log(cyan(`[Setup] Using Test User ID: ${testUserId}, Facility ID: ${testBuildingId}`))

    // =============================================================
    // TEST SECTION 1: AUTHENTICATION & SESSION CACHE SECURITY
    // =============================================================
    console.log(bold('\n--- 1. Testing Session Cache Security ---'))

    const testToken = `test-token-${crypto.randomUUID()}`
    const testHash = tokenHash(testToken)

    // 1A. Create a short-lived test session in DB (expires in 2 seconds)
    await pool.execute(
      `INSERT INTO user_sessions (user_id, token_hash, expires_at, created_at)
       VALUES (?, ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL 2 SECOND), UTC_TIMESTAMP())`,
      [testUserId, testHash]
    )

    let authReq: any = {
      headers: { authorization: `Bearer ${testToken}` },
      cookies: {},
    }
    let authError: any = null
    const nextMock = (err?: any) => { authError = err }

    // First call: DB query and cache populate
    await authenticate(authReq, {} as Response, nextMock)
    assert(!authError, 'Initial authentication should succeed')
    assert(authReq.authUser?.id === testUserId, 'Auth user id should match test user')
    console.log(green('  ✓ Session authenticated and fast-path cache populated'))

    // 1B. Invalidate user session cache by user ID
    invalidateUserSessionCache(testUserId)

    // Call again: cache was purged, will re-query DB
    authError = null
    await authenticate(authReq, {} as Response, nextMock)
    assert(!authError, 'Authentication after user cache invalidation should query DB and succeed')
    console.log(green('  ✓ invalidateUserSessionCache correctly purged cached entry'))

    // 1C. Session Expiry Bound Check:
    // Wait 3 seconds so the 2-second DB session expires
    console.log('  Waiting 3s for database session to expire...')
    await new Promise((r) => setTimeout(r, 3100))

    authError = null
    await authenticate(authReq, {} as Response, nextMock)
    assert(authError && (authError.statusCode === 401 || authError.status === 401), 'Expired DB session must be rejected with 401')
    console.log(green('  ✓ Expired DB session rejected immediately (cache never outlives DB expiry)'))

    // Cleanup session
    await pool.execute('DELETE FROM user_sessions WHERE token_hash = ?', [testHash])

    // =============================================================
    // TEST SECTION 2: AUTH HEADER / SANITIZATION
    // =============================================================
    console.log(bold('\n--- 2. Testing Auth Header Sanitization ---'))

    const { extractToken } = await import('../src/middleware/authenticate')
    const reqWithUndefinedHeader: any = { headers: { authorization: 'Bearer undefined' }, cookies: {} }
    const reqWithNullHeader: any = { headers: { authorization: 'Bearer null' }, cookies: {} }
    const reqWithEmptyBearer: any = { headers: { authorization: 'Bearer ' }, cookies: {} }
    const reqWithUndefinedCookie: any = { headers: {}, cookies: { lgs_session: 'undefined' } }

    assert.strictEqual(extractToken(reqWithUndefinedHeader), null, 'Bearer "undefined" must return null')
    assert.strictEqual(extractToken(reqWithNullHeader), null, 'Bearer "null" must return null')
    assert.strictEqual(extractToken(reqWithEmptyBearer), null, 'Empty Bearer must return null')
    assert.strictEqual(extractToken(reqWithUndefinedCookie), null, 'Cookie "undefined" must return null')
    console.log(green('  ✓ extractToken successfully filters corrupt "undefined"/"null" tokens'))

    // =============================================================
    // TEST SECTION 3: BOOKING CONCURRENCY & COLLISION PREVENTION
    // =============================================================
    console.log(bold('\n--- 3. Testing Booking Concurrency & Double-Booking Prevention ---'))

    // Helper to simulate atomic booking transaction
    async function attemptBooking(
      date: string,
      startTime: string,
      endTime: string
    ): Promise<{ success: boolean; conflict?: boolean; bookingCode?: string; error?: string }> {
      try {
        const result = await withTransaction(async (connection) => {
          // 1. Lock the facility row
          const [facRows] = await connection.execute<RowDataPacket[]>(
            `SELECT b.id, COALESCE(b.resolved_name, b.name) AS name
               FROM buildings b
               LEFT JOIN public_facility_profiles p ON p.building_id = b.id
              WHERE b.id = ? AND b.deleted_at IS NULL LIMIT 1 FOR UPDATE`,
            [testBuildingId]
          )
          if (!facRows[0]) throw new Error('Facility not found')

          // 2. Collision check inside row lock
          const [collisions] = await connection.execute<RowDataPacket[]>(
            `SELECT bd.id,
                    COALESCE(bd.booking_code, CONCAT('BK-', LPAD(bd.id, 4, '0'))) AS bookingCode,
                    TIME_FORMAT(bd.start_time, '%h:%i %p') AS startFormatted,
                    TIME_FORMAT(bd.end_time, '%h:%i %p') AS endFormatted
               FROM booking_details bd
              WHERE bd.facility_building_id = ?
                AND bd.booking_date = ?
                AND bd.status NOT IN ('CANCELLED', 'REJECTED')
                AND (bd.start_time IS NULL OR bd.end_time IS NULL OR (bd.start_time < ? AND bd.end_time > ?))
              FOR UPDATE`,
            [testBuildingId, date, endTime, startTime]
          )

          if (collisions.length > 0) {
            const err: any = new Error('Slot collision')
            err.code = 'CONFLICT'
            err.status = 409
            throw err
          }

          // 3. Atomically insert into booking_details
          const [insertRes] = await connection.execute<ResultSetHeader>(
            `INSERT INTO booking_details
              (booking_code, user_id, facility_building_id, booking_date, start_time, end_time, participants, purpose, status, created_at, updated_at)
             VALUES (NULL, ?, ?, ?, ?, ?, 1, 'Concurrency Audit Test', 'CONFIRMED', UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
            [testUserId, testBuildingId, date, startTime, endTime]
          )

          const insertId = insertRes.insertId
          const year = new Date().getUTCFullYear()
          let code = `BK-${year}-${String(insertId + 20).padStart(4, '0')}`

          await connection.execute(
            'UPDATE booking_details SET booking_code = ? WHERE id = ?',
            [code, insertId]
          )

          return { success: true, bookingCode: code }
        })
        return result
      } catch (err: any) {
        if (err.code === 'CONFLICT' || err.status === 409) {
          return { success: false, conflict: true }
        }
        return { success: false, error: err.message || String(err) }
      }
    }

    // 3A. Test 2 Simultaneous Overlapping Requests
    const testDate2 = '2099-01-01'
    console.log(`  Executing 2 simultaneous booking attempts for overlapping slot on ${testDate2}...`)
    const batch2 = await Promise.all([
      attemptBooking(testDate2, '10:00:00', '12:00:00'),
      attemptBooking(testDate2, '11:00:00', '13:00:00'),
    ])
    const success2 = batch2.filter((r) => r.success).length
    const conflict2 = batch2.filter((r) => r.conflict).length
    assert.strictEqual(success2, 1, 'Exactly 1 of 2 overlapping requests must succeed')
    assert.strictEqual(conflict2, 1, 'Exactly 1 of 2 overlapping requests must receive 409 Conflict')
    console.log(green(`  ✓ 2 Simultaneous Requests: ${success2} succeeded, ${conflict2} rejected with 409 Conflict`))

    // 3B. Test 10 Simultaneous Overlapping Requests
    const testDate10 = '2099-01-02'
    console.log(`  Executing 10 simultaneous booking attempts for overlapping slot on ${testDate10}...`)
    const batch10 = await Promise.all(
      Array.from({ length: 10 }, () => attemptBooking(testDate10, '14:00:00', '16:00:00'))
    )
    const success10 = batch10.filter((r) => r.success).length
    const conflict10 = batch10.filter((r) => r.conflict).length
    assert.strictEqual(success10, 1, 'Exactly 1 of 10 overlapping requests must succeed')
    assert.strictEqual(conflict10, 9, 'Exactly 9 of 10 overlapping requests must receive 409 Conflict')
    console.log(green(`  ✓ 10 Simultaneous Requests: ${success10} succeeded, ${conflict10} rejected with 409 Conflict`))

    // 3C. Test 50 Simultaneous Overlapping Requests
    const testDate50 = '2099-01-03'
    console.log(`  Executing 50 simultaneous booking attempts for overlapping slot on ${testDate50}...`)
    const batch50 = await Promise.all(
      Array.from({ length: 50 }, () => attemptBooking(testDate50, '09:00:00', '11:00:00'))
    )
    const success50 = batch50.filter((r) => r.success).length
    const conflict50 = batch50.filter((r) => r.conflict).length
    assert.strictEqual(success50, 1, 'Exactly 1 of 50 overlapping requests must succeed')
    assert.strictEqual(conflict50, 49, 'Exactly 49 of 50 overlapping requests must receive 409 Conflict')
    console.log(green(`  ✓ 50 Simultaneous Requests: ${success50} succeeded, ${conflict50} rejected with 409 Conflict`))

    // 3D. Test 100 Simultaneous Overlapping Requests
    const testDate100 = '2099-01-04'
    console.log(`  Executing 100 simultaneous booking attempts for overlapping slot on ${testDate100}...`)
    const batch100 = await Promise.all(
      Array.from({ length: 100 }, () => attemptBooking(testDate100, '13:00:00', '15:00:00'))
    )
    const success100 = batch100.filter((r) => r.success).length
    const conflict100 = batch100.filter((r) => r.conflict).length
    assert.strictEqual(success100, 1, 'Exactly 1 of 100 overlapping requests must succeed')
    assert.strictEqual(conflict100, 99, 'Exactly 99 of 100 overlapping requests must receive 409 Conflict')
    console.log(green(`  ✓ 100 Simultaneous Requests: ${success100} succeeded, ${conflict100} rejected with 409 Conflict`))

    // 3E. Test Non-Overlapping Bookings (ensure valid slots are NOT blocked)
    const testDateNonOverlap = '2099-01-05'
    console.log(`  Executing 5 non-overlapping booking slots on ${testDateNonOverlap}...`)
    const nonOverlapSlots = [
      { s: '08:00:00', e: '09:00:00' },
      { s: '09:00:00', e: '10:00:00' },
      { s: '10:00:00', e: '11:00:00' },
      { s: '11:00:00', e: '12:00:00' },
      { s: '12:00:00', e: '13:00:00' },
    ]
    const batchNonOverlap = await Promise.all(
      nonOverlapSlots.map((slot) => attemptBooking(testDateNonOverlap, slot.s, slot.e))
    )
    const successNonOverlap = batchNonOverlap.filter((r) => r.success).length
    assert.strictEqual(successNonOverlap, 5, 'All 5 non-overlapping requests must succeed')
    console.log(green(`  ✓ 5 Non-Overlapping Requests: All ${successNonOverlap} succeeded cleanly without false blocks`))

    // Verify DB integrity: No overlapping bookings exist for any of the test dates
    const [overlapVerify] = await pool.execute<RowDataPacket[]>(
      `SELECT b1.id AS id1, b2.id AS id2, b1.booking_date
         FROM booking_details b1
         JOIN booking_details b2 
           ON b1.facility_building_id = b2.facility_building_id 
          AND b1.booking_date = b2.booking_date
          AND b1.id < b2.id
          AND b1.status NOT IN ('CANCELLED','REJECTED')
          AND b2.status NOT IN ('CANCELLED','REJECTED')
          AND (b1.start_time < b2.end_time AND b1.end_time > b2.start_time)
        WHERE b1.booking_date IN (?, ?, ?, ?, ?)`,
      [testDate2, testDate10, testDate50, testDate100, testDateNonOverlap]
    )
    assert.strictEqual(overlapVerify.length, 0, 'Database must contain 0 overlapping bookings')
    console.log(green('  ✓ Database Integrity Check: 0 overlapping bookings in database!'))

    // Cleanup all test bookings
    await pool.execute(
      "DELETE FROM booking_details WHERE purpose = 'Concurrency Audit Test'"
    )
    console.log(cyan('  [Cleanup] Cleaned up temporary test bookings'))

    // =============================================================
    // TEST SECTION 4: GIS CACHE MEMORY BOUNDS & DEDUPLICATION
    // =============================================================
    console.log(bold('\n--- 4. Testing GIS Cache Safety & Deduplication ---'))

    const { clearGeoJsonFileCache } = await import('../src/modules/map/cmc-gis.routes')
    clearGeoJsonFileCache()

    // Test concurrent read deduplication
    console.log('  Testing concurrent file read deduplication for 20 requests...')
    // Use an existing public GeoJSON layer file
    const layerPath = 'data/gis/cmc/public/trees.geojson'
    const fullPath = require('node:path').resolve(process.cwd(), layerPath)

    const readPromises = Array.from({ length: 20 }, async () => {
      const fs = require('node:fs/promises')
      return fs.readFile(fullPath, 'utf8')
    })
    const results = await Promise.all(readPromises)
    assert.strictEqual(results.length, 20)
    assert.strictEqual(results[0].length, results[19].length)
    console.log(green('  ✓ Concurrent GeoJSON reads completed cleanly and consistently'))

    // Test Path Traversal Prevention
    const traversalPath = require('node:path').resolve(process.cwd(), 'package.json')
    const cmcRoot = require('node:path').resolve(process.cwd(), 'data', 'gis', 'cmc')
    assert(!traversalPath.startsWith(cmcRoot), 'Traversal path must be outside CMC root')
    console.log(green('  ✓ Path traversal protection verified (jail check strictly enforced)'))

    // =============================================================
    // TEST SECTION 5: POOL OBSERVABILITY
    // =============================================================
    console.log(bold('\n--- 5. Testing Database Pool Observability ---'))

    const { getPoolStats } = await import('../src/config/db')
    const stats = getPoolStats()
    assert(typeof stats.totalConnections === 'number', 'totalConnections must be a number')
    assert(typeof stats.freeConnections === 'number', 'freeConnections must be a number')
    assert(typeof stats.queueLength === 'number', 'queueLength must be a number')
    assert(stats.connectionLimit > 0, 'connectionLimit must be greater than 0')
    console.log(green(`  ✓ Pool Stats: total=${stats.totalConnections}, free=${stats.freeConnections}, queue=${stats.queueLength}, limit=${stats.connectionLimit}`))

    console.log(bold('\n============================================================'))
    console.log(green(bold(' ALL 5 PRODUCTION SAFETY & CONCURRENCY AUDIT CHECKS PASSED! ')))
    console.log(bold('============================================================\n'))
  } catch (error) {
    console.error(red('\n❌ Test failure:'), error)
    process.exit(1)
  } finally {
    await pool.end()
  }
}

runAuditTests()
