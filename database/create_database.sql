-- Run as a PostgreSQL administrator if you prefer SQL instead of: npm run db:create
-- Replace database/user/password values before production use.

CREATE DATABASE lgs;

-- Recommended: use a dedicated application account, never postgres superuser.
-- Uncomment and edit these lines when you control PostgreSQL user administration:
-- CREATE USER lgs_app WITH PASSWORD 'REPLACE_WITH_LONG_RANDOM_PASSWORD';
-- GRANT ALL PRIVILEGES ON DATABASE lgs TO lgs_app;
-- \connect lgs
-- GRANT ALL ON SCHEMA public TO lgs_app;
