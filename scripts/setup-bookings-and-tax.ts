import fs from 'node:fs'
import path from 'node:path'
import mysql, { type RowDataPacket } from 'mysql2/promise'
import 'dotenv/config'

import { getDatabaseSslConfig, parseDatabaseUrl } from '../src/config/db'

async function columnExists(connection: mysql.Connection, table: string, column: string): Promise<boolean> {
  const [rows] = await connection.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS count 
       FROM information_schema.COLUMNS 
      WHERE TABLE_SCHEMA = DATABASE() 
        AND TABLE_NAME = ? 
        AND COLUMN_NAME = ?`,
    [table, column],
  )
  return Number(rows[0]?.count || 0) > 0
}

async function indexExists(connection: mysql.Connection, table: string, indexName: string): Promise<boolean> {
  const [rows] = await connection.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS count 
       FROM information_schema.STATISTICS 
      WHERE TABLE_SCHEMA = DATABASE() 
        AND TABLE_NAME = ? 
        AND INDEX_NAME = ?`,
    [table, indexName],
  )
  return Number(rows[0]?.count || 0) > 0
}

async function foreignKeyExists(connection: mysql.Connection, table: string, constraintName: string): Promise<boolean> {
  const [rows] = await connection.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS count 
       FROM information_schema.TABLE_CONSTRAINTS 
      WHERE TABLE_SCHEMA = DATABASE() 
        AND TABLE_NAME = ? 
        AND CONSTRAINT_NAME = ?`,
    [table, constraintName],
  )
  return Number(rows[0]?.count || 0) > 0
}

async function main() {
  const db = parseDatabaseUrl()
  console.log(`Connecting to database ${db.host}:${db.port}/${db.database}...`)

  const connection = await mysql.createConnection({
    host: db.host,
    port: db.port,
    user: db.user,
    password: db.password,
    database: db.database,
    ssl: getDatabaseSslConfig(),
    multipleStatements: true,
    connectTimeout: 15_000,
  })

  try {
    console.log('Database connected successfully.')

    /* =========================================================
       1. UPGRADE booking_details TABLE
    ========================================================= */
    console.log('Configuring booking_details table schema...')

    // Make request_id NULLable so direct bookings can exist without prior service_request if needed
    try {
      await connection.query('ALTER TABLE booking_details MODIFY COLUMN request_id BIGINT UNSIGNED NULL')
    } catch (err: any) {
      console.warn('Note on request_id modify:', err?.message || err)
    }

    if (!(await columnExists(connection, 'booking_details', 'user_id'))) {
      console.log('Adding user_id to booking_details...')
      await connection.query('ALTER TABLE booking_details ADD COLUMN user_id BIGINT UNSIGNED NULL AFTER request_id')
    }

    if (!(await columnExists(connection, 'booking_details', 'booking_code'))) {
      console.log('Adding booking_code to booking_details...')
      await connection.query('ALTER TABLE booking_details ADD COLUMN booking_code VARCHAR(32) NULL AFTER id')
    }

    if (!(await indexExists(connection, 'booking_details', 'uq_booking_code'))) {
      await connection.query('ALTER TABLE booking_details ADD UNIQUE KEY uq_booking_code (booking_code)')
    }

    if (!(await indexExists(connection, 'booking_details', 'idx_booking_user_date'))) {
      await connection.query('ALTER TABLE booking_details ADD KEY idx_booking_user_date (user_id, booking_date)')
    }

    if (!(await foreignKeyExists(connection, 'booking_details', 'fk_booking_user'))) {
      try {
        await connection.query('ALTER TABLE booking_details ADD CONSTRAINT fk_booking_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL')
      } catch (err: any) {
        console.warn('Note on fk_booking_user:', err?.message || err)
      }
    }

    /* =========================================================
       2. UPGRADE tax_accounts TABLE
    ========================================================= */
    console.log('Configuring tax_accounts table schema...')

    if (!(await columnExists(connection, 'tax_accounts', 'user_id'))) {
      console.log('Adding user_id to tax_accounts...')
      await connection.query('ALTER TABLE tax_accounts ADD COLUMN user_id BIGINT UNSIGNED NULL AFTER id')
    }

    if (!(await indexExists(connection, 'tax_accounts', 'idx_tax_accounts_user'))) {
      await connection.query('ALTER TABLE tax_accounts ADD KEY idx_tax_accounts_user (user_id)')
    }

    if (!(await foreignKeyExists(connection, 'tax_accounts', 'fk_tax_accounts_user'))) {
      try {
        await connection.query('ALTER TABLE tax_accounts ADD CONSTRAINT fk_tax_accounts_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL')
      } catch (err: any) {
        console.warn('Note on fk_tax_accounts_user:', err?.message || err)
      }
    }

    /* =========================================================
       3. UPGRADE tax_payments TABLE
    ========================================================= */
    console.log('Configuring tax_payments table schema...')

    if (!(await columnExists(connection, 'tax_payments', 'user_id'))) {
      console.log('Adding user_id to tax_payments...')
      await connection.query('ALTER TABLE tax_payments ADD COLUMN user_id BIGINT UNSIGNED NULL AFTER id')
    }

    if (!(await columnExists(connection, 'tax_payments', 'description'))) {
      console.log('Adding description to tax_payments...')
      await connection.query("ALTER TABLE tax_payments ADD COLUMN description VARCHAR(255) NULL AFTER amount")
    }

    if (!(await columnExists(connection, 'tax_payments', 'status'))) {
      console.log('Adding status to tax_payments...')
      await connection.query("ALTER TABLE tax_payments ADD COLUMN status VARCHAR(30) NOT NULL DEFAULT 'COMPLETED' AFTER payment_reference")
    }

    if (!(await columnExists(connection, 'tax_payments', 'payment_method'))) {
      console.log('Adding payment_method to tax_payments...')
      await connection.query("ALTER TABLE tax_payments ADD COLUMN payment_method VARCHAR(50) NOT NULL DEFAULT 'ONLINE' AFTER status")
    }

    if (!(await indexExists(connection, 'tax_payments', 'idx_tax_payments_user_paid'))) {
      await connection.query('ALTER TABLE tax_payments ADD KEY idx_tax_payments_user_paid (user_id, paid_at)')
    }

    if (!(await foreignKeyExists(connection, 'tax_payments', 'fk_tax_payments_user'))) {
      try {
        await connection.query('ALTER TABLE tax_payments ADD CONSTRAINT fk_tax_payments_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL')
      } catch (err: any) {
        console.warn('Note on fk_tax_payments_user:', err?.message || err)
      }
    }

    /* =========================================================
       4. SEED PUBLIC FACILITIES
    ========================================================= */
    console.log('Seeding public facilities...')

    const facilities = [
      {
        code: 'LGS-FAC-000001',
        name: 'Municipal Community Hall',
        address: 'Colombo Municipal Council, Town Hall, Colombo 07',
        latitude: 6.9147,
        longitude: 79.8636,
        capacity: 350,
        openingTime: '08:00:00',
        closingTime: '21:00:00',
        description: 'Multi-purpose air-conditioned community hall for meetings, civic events, and cultural ceremonies.',
      },
      {
        code: 'LGS-FAC-000002',
        name: 'Public Sports Ground',
        address: 'Colombo Municipal Council Sports Ground, Colombo 07',
        latitude: 6.9125,
        longitude: 79.8672,
        capacity: 500,
        openingTime: '06:00:00',
        closingTime: '20:00:00',
        description: 'Natural turf sports ground suitable for football, cricket, and athletics training.',
      },
      {
        code: 'LGS-FAC-000003',
        name: 'Town Hall Auditorium',
        address: 'Colombo Municipal Council, Town Hall, Colombo 07',
        latitude: 6.9150,
        longitude: 79.8640,
        capacity: 450,
        openingTime: '08:30:00',
        closingTime: '20:00:00',
        description: 'Historic auditorium equipped with audio-visual equipment for public conferences.',
      },
      {
        code: 'LGS-FAC-000004',
        name: 'Community Meeting Room',
        address: 'Colombo Municipal Council, Meeting Room 2',
        latitude: 6.9145,
        longitude: 79.8638,
        capacity: 40,
        openingTime: '08:00:00',
        closingTime: '18:00:00',
        description: 'Air-conditioned meeting room for resident associations and civic consultations.',
      },
    ]

    for (const fac of facilities) {
      await connection.execute(
        `INSERT INTO buildings (building_code, name, resolved_name, address, building_type, public_facility, latitude, longitude, active, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'PUBLIC_FACILITY', 1, ?, ?, 1, UTC_TIMESTAMP(), UTC_TIMESTAMP())
         ON DUPLICATE KEY UPDATE 
           name = VALUES(name),
           resolved_name = VALUES(resolved_name),
           address = VALUES(address),
           public_facility = 1,
           active = 1,
           updated_at = UTC_TIMESTAMP()`,
        [fac.code, fac.name, fac.name, fac.address, fac.latitude, fac.longitude],
      )

      const [bldRows] = await connection.execute<RowDataPacket[]>(
        'SELECT id FROM buildings WHERE building_code = ? LIMIT 1',
        [fac.code],
      )
      const buildingId = bldRows[0]?.id

      if (buildingId) {
        await connection.execute(
          `INSERT INTO public_facility_profiles (building_id, bookable, capacity, opening_time, closing_time, booking_requires_approval, advance_booking_days, minimum_notice_hours, description, active, created_at, updated_at)
           VALUES (?, 1, ?, ?, ?, 0, 30, 24, ?, 1, UTC_TIMESTAMP(), UTC_TIMESTAMP())
           ON DUPLICATE KEY UPDATE 
             bookable = 1,
             capacity = VALUES(capacity),
             opening_time = VALUES(opening_time),
             closing_time = VALUES(closing_time),
             description = VALUES(description),
             active = 1,
             updated_at = UTC_TIMESTAMP()`,
          [buildingId, fac.capacity, fac.openingTime, fac.closingTime, fac.description],
        )
      }
    }

    /* =========================================================
       5. SEED BOOKINGS AND TAX DATA FOR CITIZEN USERS
    ========================================================= */
    console.log('Finding citizen users...')
    const [citizenUsers] = await connection.execute<RowDataPacket[]>(
      `SELECT u.id, u.email, u.display_name 
         FROM users u 
         JOIN roles r ON r.id = u.role_id 
        WHERE r.code = 'CITIZEN' AND u.deleted_at IS NULL`,
    )

    if (citizenUsers.length === 0) {
      console.warn('No CITIZEN role users found. Please create a citizen user first.')
    } else {
      console.log(`Found ${citizenUsers.length} citizen user(s): ${citizenUsers.map(u => u.email).join(', ')}`)

      // Fetch facility IDs
      const [hallRows] = await connection.execute<RowDataPacket[]>(
        "SELECT id FROM buildings WHERE building_code = 'LGS-FAC-000001' LIMIT 1",
      )
      const [groundRows] = await connection.execute<RowDataPacket[]>(
        "SELECT id FROM buildings WHERE building_code = 'LGS-FAC-000002' LIMIT 1",
      )
      const [auditoriumRows] = await connection.execute<RowDataPacket[]>(
        "SELECT id FROM buildings WHERE building_code = 'LGS-FAC-000003' LIMIT 1",
      )
      const [meetingRoomRows] = await connection.execute<RowDataPacket[]>(
        "SELECT id FROM buildings WHERE building_code = 'LGS-FAC-000004' LIMIT 1",
      )
      const hallId = hallRows[0]?.id
      const groundId = groundRows[0]?.id
      const auditoriumId = auditoriumRows[0]?.id
      const meetingRoomId = meetingRoomRows[0]?.id

      for (const citizen of citizenUsers) {
        console.log(`Seeding data for citizen: ${citizen.display_name} (${citizen.email}, ID: ${citizen.id})...`)

        // 1. BK-2026-0024 (Public Sports Ground, 02 Oct 2026, 04:00 PM – 06:00 PM, UPCOMING)
        if (groundId) {
          const bookingCode = 'BK-2026-0024'
          const [existing] = await connection.execute<RowDataPacket[]>(
            'SELECT id FROM booking_details WHERE booking_code = ? LIMIT 1',
            [bookingCode],
          )
          if (!existing[0]) {
            await connection.execute(
              `INSERT INTO booking_details 
                (booking_code, user_id, facility_building_id, booking_date, start_time, end_time, participants, purpose, status, created_at, updated_at)
               VALUES (?, ?, ?, '2026-10-02', '16:00:00', '18:00:00', 22, 'Friendly Community Football Match', 'UPCOMING', UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
              [bookingCode, citizen.id, groundId],
            )
          } else {
            await connection.execute(
              `UPDATE booking_details 
                  SET user_id = ?, facility_building_id = ?, status = 'UPCOMING', booking_date = '2026-10-02', start_time = '16:00:00', end_time = '18:00:00', participants = 22, purpose = 'Friendly Community Football Match'
                WHERE id = ?`,
              [citizen.id, groundId, existing[0].id],
            )
          }
        }

        // 2. BK-2026-0018 (Municipal Community Hall, 18 Oct 2026, 09:00 AM – 12:00 PM, CONFIRMED)
        if (hallId) {
          const bookingCode = 'BK-2026-0018'
          const [existing] = await connection.execute<RowDataPacket[]>(
            'SELECT id FROM booking_details WHERE booking_code = ? LIMIT 1',
            [bookingCode],
          )
          if (!existing[0]) {
            await connection.execute(
              `INSERT INTO booking_details 
                (booking_code, user_id, facility_building_id, booking_date, start_time, end_time, participants, purpose, status, created_at, updated_at)
               VALUES (?, ?, ?, '2026-10-18', '09:00:00', '12:00:00', 50, 'Municipal Community Hall Public Gathering', 'CONFIRMED', UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
              [bookingCode, citizen.id, hallId],
            )
          } else {
            await connection.execute(
              `UPDATE booking_details 
                  SET user_id = ?, facility_building_id = ?, status = 'CONFIRMED', booking_date = '2026-10-18', start_time = '09:00:00', end_time = '12:00:00', participants = 50, purpose = 'Municipal Community Hall Public Gathering'
                WHERE id = ?`,
              [citizen.id, hallId, existing[0].id],
            )
          }
        }

        // 3. BK-2026-0012 (Town Hall Auditorium, 05 Sep 2026, 01:00 PM – 04:00 PM, COMPLETED)
        if (auditoriumId) {
          const bookingCode = 'BK-2026-0012'
          const [existing] = await connection.execute<RowDataPacket[]>(
            'SELECT id FROM booking_details WHERE booking_code = ? LIMIT 1',
            [bookingCode],
          )
          if (!existing[0]) {
            await connection.execute(
              `INSERT INTO booking_details 
                (booking_code, user_id, facility_building_id, booking_date, start_time, end_time, participants, purpose, status, created_at, updated_at)
               VALUES (?, ?, ?, '2026-09-05', '13:00:00', '16:00:00', 120, 'Cultural Programme', 'COMPLETED', UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
              [bookingCode, citizen.id, auditoriumId],
            )
          } else {
            await connection.execute(
              `UPDATE booking_details 
                  SET user_id = ?, facility_building_id = ?, status = 'COMPLETED', booking_date = '2026-09-05', start_time = '13:00:00', end_time = '16:00:00', participants = 120, purpose = 'Cultural Programme'
                WHERE id = ?`,
              [citizen.id, auditoriumId, existing[0].id],
            )
          }
        }

        // 4. BK-2026-0010 (Community Meeting Room, 28 Aug 2026, 10:00 AM – 01:00 PM, CANCELLED)
        if (meetingRoomId) {
          const bookingCode = 'BK-2026-0010'
          const [existing] = await connection.execute<RowDataPacket[]>(
            'SELECT id FROM booking_details WHERE booking_code = ? LIMIT 1',
            [bookingCode],
          )
          if (!existing[0]) {
            await connection.execute(
              `INSERT INTO booking_details 
                (booking_code, user_id, facility_building_id, booking_date, start_time, end_time, participants, purpose, status, created_at, updated_at)
               VALUES (?, ?, ?, '2026-08-28', '10:00:00', '13:00:00', 15, 'Resident Association Meeting', 'CANCELLED', UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
              [bookingCode, citizen.id, meetingRoomId],
            )
          } else {
            await connection.execute(
              `UPDATE booking_details 
                  SET user_id = ?, facility_building_id = ?, status = 'CANCELLED', booking_date = '2026-08-28', start_time = '10:00:00', end_time = '13:00:00', participants = 15, purpose = 'Resident Association Meeting'
                WHERE id = ?`,
              [citizen.id, meetingRoomId, existing[0].id],
            )
          }
        }

        // --- TAX: Property, Tax Account, Assessment, and Receipts
        const propCode = `PROP-COL-${citizen.id}`
        const taxCode = `TX-ACC-${citizen.id}-2026`

        // Check or insert property
        const [propRows] = await connection.execute<RowDataPacket[]>(
          'SELECT id FROM properties WHERE property_code = ? LIMIT 1',
          [propCode],
        )
        let propertyId = propRows[0]?.id

        if (!propertyId) {
          // Link to first available building or hall
          const buildingIdForProp = hallId || 407
          await connection.execute(
            `INSERT INTO properties (property_code, building_id, assessment_value, valuation_date, property_type, created_at, updated_at)
             VALUES (?, ?, 12500000.00, '2026-01-01', 'RESIDENTIAL', UTC_TIMESTAMP(), UTC_TIMESTAMP())
             ON DUPLICATE KEY UPDATE assessment_value = 12500000.00`,
            [propCode, buildingIdForProp],
          )
          const [createdProp] = await connection.execute<RowDataPacket[]>(
            'SELECT id FROM properties WHERE property_code = ? LIMIT 1',
            [propCode],
          )
          propertyId = createdProp[0]?.id
        }

        if (propertyId) {
          // Check or insert tax account
          const [taxAcctRows] = await connection.execute<RowDataPacket[]>(
            'SELECT id FROM tax_accounts WHERE tax_code = ? OR (user_id = ? AND property_id = ?) LIMIT 1',
            [taxCode, citizen.id, propertyId],
          )
          let taxAccountId = taxAcctRows[0]?.id

          if (!taxAccountId) {
            await connection.execute(
              `INSERT INTO tax_accounts (user_id, tax_code, property_id, status, current_balance, created_at, updated_at)
               VALUES (?, ?, ?, 'CURRENT', 0.00, UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
              [citizen.id, taxCode, propertyId],
            )
            const [createdAcct] = await connection.execute<RowDataPacket[]>(
              'SELECT id FROM tax_accounts WHERE tax_code = ? LIMIT 1',
              [taxCode],
            )
            taxAccountId = createdAcct[0]?.id
          } else {
            await connection.execute(
              'UPDATE tax_accounts SET user_id = ?, current_balance = 0.00 WHERE id = ?',
              [citizen.id, taxAccountId],
            )
          }

          if (taxAccountId) {
            // Check or insert assessment for year 2026
            const [assRows] = await connection.execute<RowDataPacket[]>(
              'SELECT id FROM tax_assessments WHERE tax_account_id = ? AND tax_year = 2026 LIMIT 1',
              [taxAccountId],
            )
            let assessmentId = assRows[0]?.id

            if (!assessmentId) {
              await connection.execute(
                `INSERT INTO tax_assessments (tax_account_id, tax_year, assessed_amount, amount_due, due_date, status, created_at)
                 VALUES (?, 2026, 19400.00, 0.00, '2026-12-31', 'PAID', UTC_TIMESTAMP())`,
                [taxAccountId],
              )
              const [createdAss] = await connection.execute<RowDataPacket[]>(
                'SELECT id FROM tax_assessments WHERE tax_account_id = ? AND tax_year = 2026 LIMIT 1',
                [taxAccountId],
              )
              assessmentId = createdAss[0]?.id
            } else {
              await connection.execute(
                "UPDATE tax_assessments SET assessed_amount = 19400.00, amount_due = 0.00, status = 'PAID' WHERE id = ?",
                [assessmentId],
              )
            }

            if (assessmentId) {
              // --- RECEIPT 1: TX-2026-1042 (Assessment Tax — Q3 2026, 15 Sep 2026, LKR 4,850.00)
              const ref1 = `TX-2026-1042`
              const [pay1] = await connection.execute<RowDataPacket[]>(
                'SELECT id FROM tax_payments WHERE payment_reference = ? LIMIT 1',
                [ref1],
              )
              if (!pay1[0]) {
                await connection.execute(
                  `INSERT INTO tax_payments (tax_assessment_id, user_id, amount, description, payment_reference, status, payment_method, paid_at, created_at)
                   VALUES (?, ?, 4850.00, 'Assessment Tax — Q3 2026', ?, 'COMPLETED', 'ONLINE', '2026-09-15 10:30:00', UTC_TIMESTAMP())`,
                  [assessmentId, citizen.id, ref1],
                )
                console.log(`  Created tax receipt: ${ref1}`)
              } else {
                await connection.execute(
                  `UPDATE tax_payments SET user_id = ?, description = 'Assessment Tax — Q3 2026', status = 'COMPLETED', amount = 4850.00 WHERE id = ?`,
                  [citizen.id, pay1[0].id],
                )
              }

              // --- RECEIPT 2: TX-2026-0817 (Assessment Tax — Q2 2026, 12 Jun 2026, LKR 4,850.00)
              const ref2 = `TX-2026-0817`
              const [pay2] = await connection.execute<RowDataPacket[]>(
                'SELECT id FROM tax_payments WHERE payment_reference = ? LIMIT 1',
                [ref2],
              )
              if (!pay2[0]) {
                await connection.execute(
                  `INSERT INTO tax_payments (tax_assessment_id, user_id, amount, description, payment_reference, status, payment_method, paid_at, created_at)
                   VALUES (?, ?, 4850.00, 'Assessment Tax — Q2 2026', ?, 'COMPLETED', 'ONLINE', '2026-06-12 14:15:00', UTC_TIMESTAMP())`,
                  [assessmentId, citizen.id, ref2],
                )
                console.log(`  Created tax receipt: ${ref2}`)
              } else {
                await connection.execute(
                  `UPDATE tax_payments SET user_id = ?, description = 'Assessment Tax — Q2 2026', status = 'COMPLETED', amount = 4850.00 WHERE id = ?`,
                  [citizen.id, pay2[0].id],
                )
              }
            }
          }
        }
      }
    }

    console.log('✅ Setup for citizen bookings and tax payments completed successfully!')
  } catch (error) {
    console.error('❌ Error during setup:', error)
    process.exitCode = 1
  } finally {
    await connection.end()
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
