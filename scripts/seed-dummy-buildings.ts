import 'dotenv/config'
import fs from 'node:fs'
import path from 'node:path'
import { Client } from 'pg'
import { getDatabaseSslConfig, parseDatabaseUrl } from '../src/config/db'

interface DummyBuilding {
  code: string
  name: string
  resolvedName: string
  address: string
  buildingType: string
  latitude: number
  longitude: number
  publicFacility: boolean
  propertyCode: string
  propertyType: string
  assessmentValue: number
  taxCode: string
  taxStatus: 'CURRENT' | 'OUTSTANDING' | 'EXEMPT'
  currentBalance: number
  exemptReason?: string
  aliases: string[]
}

const dummyBuildings: DummyBuilding[] = [
  {
    code: 'LGS-BLD-000101',
    name: 'Nelum Pokuna Mahinda Rajapaksa Theatre',
    resolvedName: 'Nelum Pokuna Theatre',
    address: '110 Ananda Coomaraswamy Mawatha, Colombo 00700',
    buildingType: 'Performing Arts Theatre',
    latitude: 6.9103,
    longitude: 79.8631,
    publicFacility: true,
    propertyCode: 'PROP-NELUM-001',
    propertyType: 'CIVIC_CULTURAL',
    assessmentValue: 35000000.0,
    taxCode: 'TX-NELUM-001',
    taxStatus: 'EXEMPT',
    currentBalance: 0.0,
    exemptReason: 'National Cultural Landmark',
    aliases: [
      'Nelum Pokuna',
      'Nelum Pokuna Theatre',
      'Lotus Pond Theatre',
      'Nelum Pokuna Mahinda Rajapaksa Theatre',
    ],
  },
  {
    code: 'LGS-BLD-000102',
    name: 'Royal College Colombo',
    resolvedName: 'Royal College',
    address: 'Rajakeeya Mawatha, Colombo 00700',
    buildingType: 'Educational Institution',
    latitude: 6.9038,
    longitude: 79.8606,
    publicFacility: true,
    propertyCode: 'PROP-ROYAL-001',
    propertyType: 'EDUCATIONAL',
    assessmentValue: 48000000.0,
    taxCode: 'TX-ROYAL-001',
    taxStatus: 'EXEMPT',
    currentBalance: 0.0,
    exemptReason: 'State Educational Institution',
    aliases: ['Royal College', 'Royal College Colombo', 'RC Colombo'],
  },
  {
    code: 'LGS-BLD-000103',
    name: 'National Museum of Colombo',
    resolvedName: 'Colombo Museum',
    address: 'Sir Marcus Fernando Mawatha, Colombo 00700',
    buildingType: 'National Museum & Heritage Archive',
    latitude: 6.9098,
    longitude: 79.8609,
    publicFacility: true,
    propertyCode: 'PROP-MUSEUM-001',
    propertyType: 'HERITAGE',
    assessmentValue: 65000000.0,
    taxCode: 'TX-MUSEUM-001',
    taxStatus: 'EXEMPT',
    currentBalance: 0.0,
    exemptReason: 'National Heritage Trust',
    aliases: ['Colombo Museum', 'National Museum', 'National Museum of Colombo'],
  },
  {
    code: 'LGS-BLD-000104',
    name: 'Bandaranaike Memorial International Conference Hall',
    resolvedName: 'BMICH',
    address: 'Bauddhaloka Mawatha, Colombo 00700',
    buildingType: 'Convention & Exhibition Centre',
    latitude: 6.9015,
    longitude: 79.8735,
    publicFacility: true,
    propertyCode: 'PROP-BMICH-001',
    propertyType: 'COMMERCIAL_CIVIC',
    assessmentValue: 85000000.0,
    taxCode: 'TX-BMICH-001',
    taxStatus: 'CURRENT',
    currentBalance: 0.0,
    aliases: ['BMICH', 'Bandaranaike Conference Hall', 'BMICH Colombo'],
  },
  {
    code: 'LGS-BLD-000105',
    name: 'Independence Memorial Hall',
    resolvedName: 'Independence Hall',
    address: 'Independence Square, Colombo 00700',
    buildingType: 'National Monument & Civic Plaza',
    latitude: 6.9044,
    longitude: 79.8674,
    publicFacility: true,
    propertyCode: 'PROP-INDEP-001',
    propertyType: 'MONUMENT',
    assessmentValue: 40000000.0,
    taxCode: 'TX-INDEP-001',
    taxStatus: 'EXEMPT',
    currentBalance: 0.0,
    exemptReason: 'National Civic Monument',
    aliases: ['Independence Hall', 'Independence Square Hall', 'Independence Arcade'],
  },
  {
    code: 'LGS-BLD-000106',
    name: 'Colombo Public Library Central Complex',
    resolvedName: 'Colombo Public Library',
    address: '18 Sir Marcus Fernando Mawatha, Colombo 00700',
    buildingType: 'Municipal Public Library',
    latitude: 6.9126,
    longitude: 79.8607,
    publicFacility: true,
    propertyCode: 'PROP-LIB-001',
    propertyType: 'MUNICIPAL',
    assessmentValue: 22000000.0,
    taxCode: 'TX-LIB-001',
    taxStatus: 'EXEMPT',
    currentBalance: 0.0,
    exemptReason: 'Municipal Public Service',
    aliases: ['Colombo Public Library', 'CMC Central Library', 'Public Library Colombo'],
  },
  {
    code: 'LGS-BLD-000107',
    name: 'Viharamahadevi Park Open Air Theatre & Pavilion',
    resolvedName: 'Viharamahadevi Open Air Theatre',
    address: 'Viharamahadevi Park, Colombo 00700',
    buildingType: 'Amphitheatre & Public Pavilion',
    latitude: 6.9152,
    longitude: 79.8622,
    publicFacility: true,
    propertyCode: 'PROP-VMD-001',
    propertyType: 'PARK_FACILITY',
    assessmentValue: 18500000.0,
    taxCode: 'TX-VMD-001',
    taxStatus: 'CURRENT',
    currentBalance: 0.0,
    aliases: ['Viharamahadevi Theatre', 'Open Air Theatre Viharamahadevi'],
  },
  {
    code: 'LGS-BLD-000108',
    name: 'General Post Office Colombo',
    resolvedName: 'Colombo Central GPO',
    address: 'Janadhipathi Mawatha, Colombo 00100',
    buildingType: 'Heritage Postal & Government Office',
    latitude: 6.9348,
    longitude: 79.8437,
    publicFacility: true,
    propertyCode: 'PROP-GPO-001',
    propertyType: 'GOVERNMENT',
    assessmentValue: 52000000.0,
    taxCode: 'TX-GPO-001',
    taxStatus: 'CURRENT',
    currentBalance: 12500.0,
    aliases: ['Colombo GPO', 'General Post Office', 'Post Office Colombo'],
  },
  {
    code: 'LGS-BLD-000109',
    name: 'Sugathadasa Indoor Stadium & Sports Complex',
    resolvedName: 'Sugathadasa Stadium Complex',
    address: 'Prince of Wales Avenue, Colombo 01400',
    buildingType: 'Sports Arena & Stadium',
    latitude: 6.9463,
    longitude: 79.8703,
    publicFacility: true,
    propertyCode: 'PROP-SUGATHA-001',
    propertyType: 'SPORTS_FACILITY',
    assessmentValue: 75000000.0,
    taxCode: 'TX-SUGATHA-001',
    taxStatus: 'OUTSTANDING',
    currentBalance: 48200.0,
    aliases: ['Sugathadasa Stadium', 'Sugathadasa Sports Complex', 'Sugathadasa Indoor Stadium'],
  },
  {
    code: 'LGS-BLD-000110',
    name: 'Galle Face Green Civic Pavilion & Promenade',
    resolvedName: 'Galle Face Green Grounds',
    address: 'Galle Face Centre Road, Colombo 00300',
    buildingType: 'Urban Promenade & Public Event Ground',
    latitude: 6.9249,
    longitude: 79.8453,
    publicFacility: true,
    propertyCode: 'PROP-GFG-001',
    propertyType: 'PUBLIC_LAND',
    assessmentValue: 95000000.0,
    taxCode: 'TX-GFG-001',
    taxStatus: 'EXEMPT',
    currentBalance: 0.0,
    exemptReason: 'Public Recreational Promenade',
    aliases: ['Galle Face Green', 'Galle Face Promenade', 'Galle Face'],
  },
]

async function main() {
  const db = parseDatabaseUrl()
  console.log(`Connecting to ${db.host}:${db.port}/${db.database}...`)

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
    console.log('Database connected. Seeding dummy landmark buildings...')

    for (const bld of dummyBuildings) {
      // 1. Upsert building
      await client.query(
        `INSERT INTO buildings (
           building_code, name, resolved_name, address, building_type,
           latitude, longitude, public_facility, active, created_at, updated_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
         ON CONFLICT (building_code) DO UPDATE
           SET name = EXCLUDED.name,
               resolved_name = EXCLUDED.resolved_name,
               address = EXCLUDED.address,
               building_type = EXCLUDED.building_type,
               latitude = EXCLUDED.latitude,
               longitude = EXCLUDED.longitude,
               public_facility = EXCLUDED.public_facility,
               active = TRUE,
               updated_at = CURRENT_TIMESTAMP`,
        [
          bld.code,
          bld.name,
          bld.resolvedName,
          bld.address,
          bld.buildingType,
          bld.latitude,
          bld.longitude,
          bld.publicFacility,
        ],
      )

      // Fetch the building ID
      const bRes = await client.query(
        'SELECT id FROM buildings WHERE building_code = $1 LIMIT 1',
        [bld.code],
      )
      const buildingId = bRes.rows[0]?.id

      if (!buildingId) continue

      // 2. Upsert Property
      await client.query(
        `INSERT INTO properties (
           property_code, building_id, assessment_value, valuation_date,
           property_type, created_at, updated_at
         )
         VALUES ($1, $2, $3, '2026-01-01', $4, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
         ON CONFLICT (property_code) DO UPDATE
           SET building_id = EXCLUDED.building_id,
               assessment_value = EXCLUDED.assessment_value,
               property_type = EXCLUDED.property_type,
               updated_at = CURRENT_TIMESTAMP`,
        [bld.propertyCode, buildingId, bld.assessmentValue, bld.propertyType],
      )

      const pRes = await client.query(
        'SELECT id FROM properties WHERE property_code = $1 LIMIT 1',
        [bld.propertyCode],
      )
      const propertyId = pRes.rows[0]?.id

      if (propertyId) {
        // 3. Upsert Tax Account
        const tRes = await client.query(
          'SELECT id FROM tax_accounts WHERE tax_code = $1 OR property_id = $2 LIMIT 1',
          [bld.taxCode, propertyId],
        )

        if (tRes.rows.length === 0) {
          await client.query(
            `INSERT INTO tax_accounts (
               property_id, tax_code, status, current_balance, exempt_reason,
               created_at, updated_at
             )
             VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
            [
              propertyId,
              bld.taxCode,
              bld.taxStatus,
              bld.currentBalance,
              bld.exemptReason || null,
            ],
          )
        } else {
          await client.query(
            `UPDATE tax_accounts
                SET tax_code = $1,
                    status = $2,
                    current_balance = $3,
                    exempt_reason = $4,
                    updated_at = CURRENT_TIMESTAMP
              WHERE id = $5`,
            [
              bld.taxCode,
              bld.taxStatus,
              bld.currentBalance,
              bld.exemptReason || null,
              tRes.rows[0].id,
            ],
          )
        }
      }

      // 4. Aliases
      for (const alias of bld.aliases) {
        const aRes = await client.query(
          'SELECT id FROM building_aliases WHERE building_id = $1 AND name = $2 LIMIT 1',
          [buildingId, alias],
        )
        if (aRes.rows.length === 0) {
          await client.query(
            `INSERT INTO building_aliases (building_id, name, source, is_primary, created_at)
             VALUES ($1, $2, 'MANUAL_SEED', $3, CURRENT_TIMESTAMP)`,
            [buildingId, alias, alias === bld.resolvedName],
          )
        }
      }

      console.log(`✓ Inserted/Updated: ${bld.resolvedName} (${bld.code})`)
    }

    console.log('\nAll 10 dummy landmark buildings successfully seeded into PostgreSQL!')
  } finally {
    await client.end()
  }
}

main().catch((err) => {
  console.error('Failed to seed landmark buildings:', err)
  process.exit(1)
})
