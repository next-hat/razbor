#!/usr/bin/env bash
set -euo pipefail

# Production init-container entrypoint. Retry readiness, never a failed migration.
mode="${1:-migrate}"
case "$mode" in
  migrate|--wait-schema) : "${RAZBOR_MIGRATION_DATABASE_URL:?Migration database URL is required}" ;;
  *) printf '%s\n' 'Usage: deploy-migrate.sh [--wait-schema]' >&2; exit 2 ;;
esac

# libpq does not expand a connection URI supplied through PGDATABASE. Parse it
# into environment fields so credentials stay out of psql's command arguments.
mapfile -d '' -t database_fields < <(node --input-type=module <<'JS'
try {
  const url = new URL(process.env.RAZBOR_MIGRATION_DATABASE_URL);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.search || url.hash) {
    throw new Error('invalid deployment connection');
  }
  const fields = [url.hostname.replace(/^\[|\]$/g, ''), url.port || '5432',
    decodeURIComponent(url.pathname.slice(1)), decodeURIComponent(url.username),
    decodeURIComponent(url.password)];
  if (fields.some(value => !value || /[\r\n\0]/.test(value))) {
    throw new Error('invalid deployment connection');
  }
  process.stdout.write(fields.join('\0') + '\0');
} catch {
  process.stderr.write('Invalid deployment database URL.\n');
  process.exit(1);
}
JS
)
if ((${#database_fields[@]} != 5)); then exit 1; fi
export PGHOST="${database_fields[0]}" PGPORT="${database_fields[1]}"
export PGDATABASE="${database_fields[2]}" PGUSER="${database_fields[3]}"
export PGPASSWORD="${database_fields[4]}"
export PGCONNECT_TIMEOUT=5

if [[ "$mode" == --wait-schema ]]; then
  # Drizzle records SHA-256 hashes of the SQL files in its existing journals.
  # Waiting for both current hashes also gates upgrades, not just fresh installs.
  hashes="$(node --input-type=module <<'JS'
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
for (const directory of ['migrations', 'embedding-migrations']) {
  const root = `packages/database/${directory}`;
  const journal = JSON.parse(readFileSync(`${root}/meta/_journal.json`, 'utf8'));
  const tag = journal.entries.at(-1).tag;
  console.log(createHash('sha256').update(readFileSync(`${root}/${tag}.sql`, 'utf8')).digest('hex'));
}
JS
  )"
  base_hash="${hashes%%$'\n'*}"
  embedding_hash="${hashes##*$'\n'}"
  readiness="SELECT EXISTS (SELECT 1 FROM drizzle.__drizzle_migrations WHERE hash='$base_hash') AND EXISTS (SELECT 1 FROM drizzle.__drizzle_embeddings_migrations WHERE hash='$embedding_hash');"
else
  readiness="SELECT EXISTS (SELECT 1 FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace WHERE e.extname='vector' AND n.nspname='public');"
fi

deadline=$((SECONDS + 300))
# Bound blocked readiness queries without limiting the migrations themselves.
until [[ "$(PGOPTIONS='-c statement_timeout=5000 -c lock_timeout=5000' psql -X --no-password -qAt -c "$readiness" 2>/dev/null || true)" == t ]]; do
  if ((SECONDS >= deadline)); then
    printf '%s\n' 'Database readiness timed out; inspect database and migration container logs.' >&2
    exit 1
  fi
  sleep 2
done

if [[ "$mode" == --wait-schema ]]; then exit 0; fi
node --import=tsx scripts/manage.ts database migrate
exec node --import=tsx scripts/manage.ts database migrate-embeddings
