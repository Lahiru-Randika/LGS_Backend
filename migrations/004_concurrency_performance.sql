-- LGS concurrency/performance hardening.
-- Existing schema already contains the main workflow indexes and service_requests.version.
-- These indexes target the common "not deleted + newest" list and map viewport lookups.

CREATE INDEX idx_requests_deleted_created
  ON service_requests (deleted_at, created_at);

CREATE INDEX idx_requests_deleted_status_created
  ON service_requests (deleted_at, status, created_at);

CREATE INDEX idx_requests_map_active_location
  ON service_requests (deleted_at, status, latitude, longitude);
