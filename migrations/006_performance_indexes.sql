-- Migration 006: Performance & Production Hardening Indexes
SET client_encoding = 'UTF8';

-- 1. Covering index for booking availability and collision detection
CREATE INDEX IF NOT EXISTS idx_booking_avail_covering
  ON booking_details (facility_building_id, booking_date, status, start_time, end_time);

-- 2. Covering composite indexes for role-based request queues & pagination (eliminates filesort)
CREATE INDEX IF NOT EXISTS idx_requests_deleted_creator_created
  ON service_requests (deleted_at, created_by_user_id, created_at);

CREATE INDEX IF NOT EXISTS idx_requests_deleted_assignee_created
  ON service_requests (deleted_at, assigned_to_user_id, created_at);

CREATE INDEX IF NOT EXISTS idx_requests_deleted_dept_created
  ON service_requests (deleted_at, department_id, created_at);

CREATE INDEX IF NOT EXISTS idx_requests_deleted_ward_created
  ON service_requests (deleted_at, ward_id, created_at);

-- 3. Notification feed index (eliminates filesort on user notification lists)
CREATE INDEX IF NOT EXISTS idx_notifications_user_created
  ON notifications (user_id, created_at);

-- 4. Fast spatial bounding-box lookup for active buildings
CREATE INDEX IF NOT EXISTS idx_buildings_active_deleted_lat_lng
  ON buildings (active, deleted_at, latitude, longitude);

-- 5. Bookable public facilities index
CREATE INDEX IF NOT EXISTS idx_buildings_public_active
  ON buildings (public_facility, active, deleted_at);
