#!/bin/sh
set -eu
# Runs only for a new PostgreSQL volume. Never resets existing data or passwords.
psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --set=ON_ERROR_STOP=1 <<'SQL'
\getenv migration_password RAZBOR_DB_MIGRATION_PASSWORD
\getenv runtime_password RAZBOR_DB_RUNTIME_PASSWORD
CREATE ROLE razbor_migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD :'migration_password';
CREATE ROLE razbor_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD :'runtime_password';
ALTER DATABASE razbor OWNER TO razbor_migrator;
ALTER SCHEMA public OWNER TO razbor_migrator;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO razbor_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE razbor_migrator IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO razbor_runtime;
SQL
