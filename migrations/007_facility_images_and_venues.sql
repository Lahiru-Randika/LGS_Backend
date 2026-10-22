-- Migration 007: Facility Images and Initial 4 Venues (No Dummy Bookings)
SET client_encoding = 'UTF8';

-- 1. Add image_url to public_facility_profiles if not present
ALTER TABLE public_facility_profiles ADD COLUMN IF NOT EXISTS image_url VARCHAR(500) NULL;

-- 2. Clean any existing dummy/sample bookings to ensure a fresh, pure database flow
DELETE FROM booking_details WHERE booking_code LIKE 'BK-2026-%' OR purpose LIKE '%Friendly Community Football Match%' OR purpose LIKE '%Municipal Community Hall Public Gathering%' OR purpose LIKE '%Cultural Programme%' OR purpose LIKE '%Resident Association Meeting%';

-- 3. Upsert the 4 initial official Municipal Venues
-- Venue 1: Municipal Community Hall
INSERT INTO buildings (building_code, name, resolved_name, address, building_type, public_facility, latitude, longitude, active, created_at, updated_at)
VALUES ('LGS-FAC-000001', 'Municipal Community Hall', 'Municipal Community Hall', 'Colombo Municipal Council, Town Hall, Colombo 07', 'PUBLIC_FACILITY', TRUE, 6.9147, 79.8636, TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT (building_code) DO UPDATE
  SET name = EXCLUDED.name,
      resolved_name = EXCLUDED.resolved_name,
      address = EXCLUDED.address,
      public_facility = TRUE,
      active = TRUE,
      deleted_at = NULL,
      updated_at = CURRENT_TIMESTAMP;

INSERT INTO public_facility_profiles (building_id, bookable, capacity, opening_time, closing_time, booking_requires_approval, advance_booking_days, minimum_notice_hours, description, image_url, active, created_at, updated_at)
SELECT b.id, TRUE, 350, '08:00:00'::TIME, '21:00:00'::TIME, FALSE, 30, 24, 'Multi-purpose air-conditioned community hall for meetings, civic events, and cultural ceremonies.', '/uploads/facilities/community-hall.jpg', TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM buildings b WHERE b.building_code = 'LGS-FAC-000001'
ON CONFLICT (building_id) DO UPDATE
  SET bookable = TRUE,
      capacity = EXCLUDED.capacity,
      opening_time = EXCLUDED.opening_time,
      closing_time = EXCLUDED.closing_time,
      description = EXCLUDED.description,
      image_url = EXCLUDED.image_url,
      active = TRUE,
      updated_at = CURRENT_TIMESTAMP;

-- Venue 2: Public Sports Ground
INSERT INTO buildings (building_code, name, resolved_name, address, building_type, public_facility, latitude, longitude, active, created_at, updated_at)
VALUES ('LGS-FAC-000002', 'Public Sports Ground', 'Public Sports Ground', 'Colombo Municipal Council Sports Ground, Colombo 07', 'PUBLIC_FACILITY', TRUE, 6.9125, 79.8672, TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT (building_code) DO UPDATE
  SET name = EXCLUDED.name,
      resolved_name = EXCLUDED.resolved_name,
      address = EXCLUDED.address,
      public_facility = TRUE,
      active = TRUE,
      deleted_at = NULL,
      updated_at = CURRENT_TIMESTAMP;

INSERT INTO public_facility_profiles (building_id, bookable, capacity, opening_time, closing_time, booking_requires_approval, advance_booking_days, minimum_notice_hours, description, image_url, active, created_at, updated_at)
SELECT b.id, TRUE, 500, '06:00:00'::TIME, '20:00:00'::TIME, FALSE, 30, 24, 'Natural turf sports ground suitable for football, cricket, and athletics training.', '/uploads/facilities/sports-ground.jpg', TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM buildings b WHERE b.building_code = 'LGS-FAC-000002'
ON CONFLICT (building_id) DO UPDATE
  SET bookable = TRUE,
      capacity = EXCLUDED.capacity,
      opening_time = EXCLUDED.opening_time,
      closing_time = EXCLUDED.closing_time,
      description = EXCLUDED.description,
      image_url = EXCLUDED.image_url,
      active = TRUE,
      updated_at = CURRENT_TIMESTAMP;

-- Venue 3: Town Hall Auditorium
INSERT INTO buildings (building_code, name, resolved_name, address, building_type, public_facility, latitude, longitude, active, created_at, updated_at)
VALUES ('LGS-FAC-000003', 'Town Hall Auditorium', 'Town Hall Auditorium', 'Colombo Municipal Council, Town Hall, Colombo 07', 'PUBLIC_FACILITY', TRUE, 6.9150, 79.8640, TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT (building_code) DO UPDATE
  SET name = EXCLUDED.name,
      resolved_name = EXCLUDED.resolved_name,
      address = EXCLUDED.address,
      public_facility = TRUE,
      active = TRUE,
      deleted_at = NULL,
      updated_at = CURRENT_TIMESTAMP;

INSERT INTO public_facility_profiles (building_id, bookable, capacity, opening_time, closing_time, booking_requires_approval, advance_booking_days, minimum_notice_hours, description, image_url, active, created_at, updated_at)
SELECT b.id, TRUE, 450, '08:30:00'::TIME, '20:00:00'::TIME, FALSE, 30, 24, 'Historic auditorium equipped with audio-visual equipment for public conferences.', '/uploads/facilities/town-hall-auditorium.jpg', TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM buildings b WHERE b.building_code = 'LGS-FAC-000003'
ON CONFLICT (building_id) DO UPDATE
  SET bookable = TRUE,
      capacity = EXCLUDED.capacity,
      opening_time = EXCLUDED.opening_time,
      closing_time = EXCLUDED.closing_time,
      description = EXCLUDED.description,
      image_url = EXCLUDED.image_url,
      active = TRUE,
      updated_at = CURRENT_TIMESTAMP;

-- Venue 4: Community Meeting Room
INSERT INTO buildings (building_code, name, resolved_name, address, building_type, public_facility, latitude, longitude, active, created_at, updated_at)
VALUES ('LGS-FAC-000004', 'Community Meeting Room', 'Community Meeting Room', 'Colombo Municipal Council, Meeting Room 2', 'PUBLIC_FACILITY', TRUE, 6.9145, 79.8638, TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT (building_code) DO UPDATE
  SET name = EXCLUDED.name,
      resolved_name = EXCLUDED.resolved_name,
      address = EXCLUDED.address,
      public_facility = TRUE,
      active = TRUE,
      deleted_at = NULL,
      updated_at = CURRENT_TIMESTAMP;

INSERT INTO public_facility_profiles (building_id, bookable, capacity, opening_time, closing_time, booking_requires_approval, advance_booking_days, minimum_notice_hours, description, image_url, active, created_at, updated_at)
SELECT b.id, TRUE, 40, '08:00:00'::TIME, '18:00:00'::TIME, FALSE, 30, 24, 'Air-conditioned meeting room for resident associations and civic consultations.', '/uploads/facilities/meeting-room.jpg', TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM buildings b WHERE b.building_code = 'LGS-FAC-000004'
ON CONFLICT (building_id) DO UPDATE
  SET bookable = TRUE,
      capacity = EXCLUDED.capacity,
      opening_time = EXCLUDED.opening_time,
      closing_time = EXCLUDED.closing_time,
      description = EXCLUDED.description,
      image_url = EXCLUDED.image_url,
      active = TRUE,
      updated_at = CURRENT_TIMESTAMP;
