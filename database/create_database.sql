-- Run as a MySQL administrator if you prefer SQL instead of: npm run db:create
-- Replace database/user/password values before production use.

CREATE DATABASE IF NOT EXISTS lgs
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_0900_ai_ci;

-- Recommended: use a dedicated application account, never MySQL root.
-- Uncomment and edit these lines when you control MySQL user administration.
-- CREATE USER 'lgs_app'@'%' IDENTIFIED BY 'REPLACE_WITH_LONG_RANDOM_PASSWORD';
-- GRANT SELECT, INSERT, UPDATE, DELETE, EXECUTE ON lgs.* TO 'lgs_app'@'%';
-- FLUSH PRIVILEGES;

-- Migration privileges are often separated from runtime privileges in production.
-- A migration account may additionally need CREATE, ALTER, INDEX, REFERENCES, DROP.
