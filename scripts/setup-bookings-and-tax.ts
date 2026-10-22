import fs from 'node:fs'
import path from 'node:path'
import { Client } from 'pg'
import 'dotenv/config'

import { getDatabaseSslConfig, parseDatabaseUrl } from '../src/config/db'

async function columnExists(client: Client, table: string, column: string): Promise<boolean> {
  const res = await client.query(
    `SELECT COUNT(*) AS count 
       FROM information_schema.columns 
      WHERE table_schema = current_schema() 
        AND table_name = $1 
        AND column_name = $2`,
    [table, column],
  )
  return Number(res.rows[0]?.count || 0) > 0
}

async function indexExists(client: Client, table: string, indexName: string): Promise<boolean> {
  const res = await client.query(
    `SELECT COUNT(*) AS count 
       FROM pg_indexes 
      WHERE schemaname = current_schema() 
        AND tablename = $1 
        AND indexname = $2`,
    [table, indexName],
  )
  return Number(res.rows[0]?.count || 0) > 0
}

async function foreignKeyExists(client: Client, table: string, constraintName: string): Promise<boolean> {
  const res = await client.query(
    `SELECT COUNT(*) AS count 
       FROM information_schema.table_constraints 
      WHERE table_schema = current_schema() 
        AND table_name = $1 
        AND constraint_name = $2
        AND constraint_type = 'FOREIGN KEY'`,
    [table, constraintName],
  )
  return Number(res.rows[0]?.count || 0) > 0
}

async function main() {
  const db = parseDatabaseUrl()
  console.log(`Connecting to database ${db.host}:${db.port}/${db.database}...`)

  const client = new Client({
    host: db.host,
    port: db.port,
    user: db.user,
    password: db.password,
    database: db.database,
    ssl: getDatabaseSslConfig(),
    connectionTimeoutMillis: 15_000,
  })

  await client.connect()

  try {
    console.log('Database connected successfully.')

    /* =========================================================
       1. UPGRADE booking_details TABLE
    ========================================================= */
    console.log('Configuring booking_details table schema...')

    try {
      await client.query('ALTER TABLE booking_details ALTER COLUMN request_id DROP NOT NULL')
    } catch (err: any) {
      console.warn('Note on request_id modify:', err?.message || err)
    }

    if (!(await columnExists(client, 'booking_details', 'user_id'))) {
      console.log('Adding user_id to booking_details...')
      await client.query('ALTER TABLE booking_details ADD COLUMN user_id BIGINT NULL')
    }

    if (!(await columnExists(client, 'booking_details', 'booking_code'))) {
      console.log('Adding booking_code to booking_details...')
      await client.query('ALTER TABLE booking_details ADD COLUMN booking_code VARCHAR(32) NULL')
    }

    if (!(await indexExists(client, 'booking_details', 'uq_booking_code'))) {
      try {
        await client.query('ALTER TABLE booking_details ADD CONSTRAINT uq_booking_code UNIQUE (booking_code)')
      } catch (err: any) {
        console.warn('Note on uq_booking_code:', err?.message || err)
      }
    }

    if (!(await indexExists(client, 'booking_details', 'idx_booking_user_date'))) {
      await client.query('CREATE INDEX IF NOT EXISTS idx_booking_user_date ON booking_details (user_id, booking_date)')
    }

    if (!(await foreignKeyExists(client, 'booking_details', 'fk_booking_user'))) {
      try {
        await client.query('ALTER TABLE booking_details ADD CONSTRAINT fk_booking_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL')
      } catch (err: any) {
        console.warn('Note on fk_booking_user:', err?.message || err)
      }
    }

    /* =========================================================
       2. UPGRADE tax_accounts TABLE
    ========================================================= */
    console.log('Configuring tax_accounts table schema...')

    if (!(await columnExists(client, 'tax_accounts', 'user_id'))) {
      console.log('Adding user_id to tax_accounts...')
      await client.query('ALTER TABLE tax_accounts ADD COLUMN user_id BIGINT NULL')
    }

    if (!(await indexExists(client, 'tax_accounts', 'idx_tax_accounts_user'))) {
      await client.query('CREATE INDEX IF NOT EXISTS idx_tax_accounts_user ON tax_accounts (user_id)')
    }

    if (!(await foreignKeyExists(client, 'tax_accounts', 'fk_tax_accounts_user'))) {
      try {
        await client.query('ALTER TABLE tax_accounts ADD CONSTRAINT fk_tax_accounts_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL')
      } catch (err: any) {
        console.warn('Note on fk_tax_accounts_user:', err?.message || err)
      }
    }

    /* =========================================================
       3. UPGRADE tax_payments TABLE
    ========================================================= */
    console.log('Configuring tax_payments table schema...')

    if (!(await columnExists(client, 'tax_payments', 'user_id'))) {
      console.log('Adding user_id to tax_payments...')
      await client.query('ALTER TABLE tax_payments ADD COLUMN user_id BIGINT NULL')
    }

    if (!(await columnExists(client, 'tax_payments', 'description'))) {
      console.log('Adding description to tax_payments...')
      await client.query('ALTER TABLE tax_payments ADD COLUMN description VARCHAR(255) NULL')
    }

    if (!(await columnExists(client, 'tax_payments', 'status'))) {
      console.log('Adding status to tax_payments...')
      await client.query("ALTER TABLE tax_payments ADD COLUMN status VARCHAR(30) NOT NULL DEFAULT 'COMPLETED'")
    }

    if (!(await columnExists(client, 'tax_payments', 'payment_method'))) {
      console.log('Adding payment_method to tax_payments...')
      await client.query("ALTER TABLE tax_payments ADD COLUMN payment_method VARCHAR(50) NOT NULL DEFAULT 'ONLINE'")
    }

    if (!(await indexExists(client, 'tax_payments', 'idx_tax_payments_user_paid'))) {
      await client.query('CREATE INDEX IF NOT EXISTS idx_tax_payments_user_paid ON tax_payments (user_id, paid_at)')
    }

    if (!(await foreignKeyExists(client, 'tax_payments', 'fk_tax_payments_user'))) {
      try {
        await client.query('ALTER TABLE tax_payments ADD CONSTRAINT fk_tax_payments_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL')
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
        imageUrl: '/uploads/facilities/community-hall.jpg',
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
        imageUrl: '/uploads/facilities/sports-ground.jpg',
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
        imageUrl: '/uploads/facilities/town-hall-auditorium.jpg',
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
        imageUrl: '/uploads/facilities/meeting-room.jpg',
      },
    ]

    for (const fac of facilities) {
      await client.query(
        `INSERT INTO buildings (building_code, name, resolved_name, address, building_type, public_facility, latitude, longitude, active, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 'PUBLIC_FACILITY', TRUE, $5, $6, TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
         ON CONFLICT (building_code) DO UPDATE 
           SET name = EXCLUDED.name,
               resolved_name = EXCLUDED.resolved_name,
               address = EXCLUDED.address,
               public_facility = TRUE,
               active = TRUE,
               updated_at = CURRENT_TIMESTAMP`,
        [fac.code, fac.name, fac.name, fac.address, fac.latitude, fac.longitude],
      )

      const bldRes = await client.query(
        'SELECT id FROM buildings WHERE building_code = $1 LIMIT 1',
        [fac.code],
      )
      const buildingId = bldRes.rows[0]?.id

      if (buildingId) {
        await client.query(
          `INSERT INTO public_facility_profiles (building_id, bookable, capacity, opening_time, closing_time, booking_requires_approval, advance_booking_days, minimum_notice_hours, description, image_url, active, created_at, updated_at)
           VALUES ($1, TRUE, $2, $3, $4, FALSE, 30, 24, $5, $6, TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
           ON CONFLICT (building_id) DO UPDATE 
             SET bookable = TRUE,
                 capacity = EXCLUDED.capacity,
                 opening_time = EXCLUDED.opening_time,
                 closing_time = EXCLUDED.closing_time,
                 description = EXCLUDED.description,
                 image_url = EXCLUDED.image_url,
                 active = TRUE,
                 updated_at = CURRENT_TIMESTAMP`,
          [buildingId, fac.capacity, fac.openingTime, fac.closingTime, fac.description, fac.imageUrl],
        )
      }
    }

    /* =========================================================
       5. SEED BOOKINGS AND TAX DATA FOR CITIZEN USERS
    ========================================================= */
    console.log('Finding citizen users...')
    const citizenRes = await client.query(
      `SELECT u.id, u.email, u.display_name 
         FROM users u 
         JOIN roles r ON r.id = u.role_id 
        WHERE r.code = 'CITIZEN' AND u.deleted_at IS NULL`,
    )
    const citizenUsers = citizenRes.rows

    if (citizenUsers.length === 0) {
      console.warn('No CITIZEN role users found. Please create a citizen user first.')
    } else {
      console.log(`Found ${citizenUsers.length} citizen user(s): ${citizenUsers.map(u => u.email).join(', ')}`)

      // Fetch facility IDs
      const hallRes = await client.query("SELECT id FROM buildings WHERE building_code = 'LGS-FAC-000001' LIMIT 1")
      const groundRes = await client.query("SELECT id FROM buildings WHERE building_code = 'LGS-FAC-000002' LIMIT 1")
      const auditoriumRes = await client.query("SELECT id FROM buildings WHERE building_code = 'LGS-FAC-000003' LIMIT 1")
      const meetingRoomRes = await client.query("SELECT id FROM buildings WHERE building_code = 'LGS-FAC-000004' LIMIT 1")

      const hallId = hallRes.rows[0]?.id
      const groundId = groundRes.rows[0]?.id
      const auditoriumId = auditoriumRes.rows[0]?.id
      const meetingRoomId = meetingRoomRes.rows[0]?.id

      for (const citizen of citizenUsers) {
        console.log(`Setting up tax data for citizen: ${citizen.display_name} (${citizen.email}, ID: ${citizen.id})...`)
        // Skipping dummy bookings insertion: Authenticated booking flow is active and driven by real user reservations.

        // --- TAX: Property, Tax Account, Assessment, and Receipts
        const propCode = `PROP-COL-${citizen.id}`
        const taxCode = `TX-ACC-${citizen.id}-2026`

        const propRes = await client.query(
          'SELECT id FROM properties WHERE property_code = $1 LIMIT 1',
          [propCode],
        )
        let propertyId = propRes.rows[0]?.id

        if (!propertyId) {
          const buildingIdForProp = hallId || 407
          await client.query(
            `INSERT INTO properties (property_code, building_id, assessment_value, valuation_date, property_type, created_at, updated_at)
             VALUES ($1, $2, 12500000.00, '2026-01-01', 'RESIDENTIAL', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
             ON CONFLICT (property_code) DO UPDATE SET assessment_value = 12500000.00`,
            [propCode, buildingIdForProp],
          )
          const createdProp = await client.query(
            'SELECT id FROM properties WHERE property_code = $1 LIMIT 1',
            [propCode],
          )
          propertyId = createdProp.rows[0]?.id
        }

        if (propertyId) {
          const taxAcctRes = await client.query(
            'SELECT id FROM tax_accounts WHERE tax_code = $1 OR (user_id = $2 AND property_id = $3) LIMIT 1',
            [taxCode, citizen.id, propertyId],
          )
          let taxAccountId = taxAcctRes.rows[0]?.id

          if (!taxAccountId) {
            await client.query(
              `INSERT INTO tax_accounts (user_id, tax_code, property_id, status, current_balance, created_at, updated_at)
               VALUES ($1, $2, $3, 'CURRENT', 0.00, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
              [citizen.id, taxCode, propertyId],
            )
            const createdAcct = await client.query(
              'SELECT id FROM tax_accounts WHERE tax_code = $1 LIMIT 1',
              [taxCode],
            )
            taxAccountId = createdAcct.rows[0]?.id
          } else {
            await client.query(
              'UPDATE tax_accounts SET user_id = $1, current_balance = 0.00 WHERE id = $2',
              [citizen.id, taxAccountId],
            )
          }

          if (taxAccountId) {
            const assRes = await client.query(
              'SELECT id FROM tax_assessments WHERE tax_account_id = $1 AND tax_year = 2026 LIMIT 1',
              [taxAccountId],
            )
            let assessmentId = assRes.rows[0]?.id

            if (!assessmentId) {
              await client.query(
                `INSERT INTO tax_assessments (tax_account_id, tax_year, assessed_amount, amount_due, due_date, status, created_at)
                 VALUES ($1, 2026, 19400.00, 0.00, '2026-12-31', 'PAID', CURRENT_TIMESTAMP)`,
                [taxAccountId],
              )
              const createdAss = await client.query(
                'SELECT id FROM tax_assessments WHERE tax_account_id = $1 AND tax_year = 2026 LIMIT 1',
                [taxAccountId],
              )
              assessmentId = createdAss.rows[0]?.id
            } else {
              await client.query(
                "UPDATE tax_assessments SET assessed_amount = 19400.00, amount_due = 0.00, status = 'PAID' WHERE id = $1",
                [assessmentId],
              )
            }

            if (assessmentId) {
              // --- RECEIPT 1: TX-2026-1042
              const ref1 = `TX-2026-1042`
              const pay1 = await client.query(
                'SELECT id FROM tax_payments WHERE payment_reference = $1 LIMIT 1',
                [ref1],
              )
              if (!pay1.rows[0]) {
                await client.query(
                  `INSERT INTO tax_payments (tax_assessment_id, user_id, amount, description, payment_reference, status, payment_method, paid_at, created_at)
                   VALUES ($1, $2, 4850.00, 'Assessment Tax — Q3 2026', $3, 'COMPLETED', 'ONLINE', '2026-09-15 10:30:00', CURRENT_TIMESTAMP)`,
                  [assessmentId, citizen.id, ref1],
                )
                console.log(`  Created tax receipt: ${ref1}`)
              } else {
                await client.query(
                  `UPDATE tax_payments SET user_id = $1, description = 'Assessment Tax — Q3 2026', status = 'COMPLETED', amount = 4850.00 WHERE id = $2`,
                  [citizen.id, pay1.rows[0].id],
                )
              }

              // --- RECEIPT 2: TX-2026-0817
              const ref2 = `TX-2026-0817`
              const pay2 = await client.query(
                'SELECT id FROM tax_payments WHERE payment_reference = $1 LIMIT 1',
                [ref2],
              )
              if (!pay2.rows[0]) {
                await client.query(
                  `INSERT INTO tax_payments (tax_assessment_id, user_id, amount, description, payment_reference, status, payment_method, paid_at, created_at)
                   VALUES ($1, $2, 4850.00, 'Assessment Tax — Q2 2026', $3, 'COMPLETED', 'ONLINE', '2026-06-12 14:15:00', CURRENT_TIMESTAMP)`,
                  [assessmentId, citizen.id, ref2],
                )
                console.log(`  Created tax receipt: ${ref2}`)
              } else {
                await client.query(
                  `UPDATE tax_payments SET user_id = $1, description = 'Assessment Tax — Q2 2026', status = 'COMPLETED', amount = 4850.00 WHERE id = $2`,
                  [citizen.id, pay2.rows[0].id],
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
    await client.end()
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
