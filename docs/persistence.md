# Data, accounts, and recovery

For a new installation, follow [getting started](getting-started.md). This guide
covers persistent data, account access, optional configuration, and recovery.

## Know where data lives

| Location                               | Contents                                                                                                                                     |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| PostgreSQL `postgres_data` volume      | Accounts, repositories, reviewer settings, runner registrations, token metadata, reviews, results, vectors, pg-boss jobs, and progress logs. |
| `RAZBOR_INDEX_DATA` directory          | Indexer checkouts and Codebase Memory files.                                                                                                 |
| `RAZBOR_STORAGE_HOST` directory        | Runner identity and local job data.                                                                                                          |
| `razbor_runner_registration` volume    | Development Compose runner provisioning secret.                                                                                              |
| `razbor_embedding_models` volume       | Verified embedding models.                                                                                                                   |
| Private `.env`, TOML, and secret files | Credentials, paths, and optional file-managed registrations.                                                                                 |

Volume names include the Compose project prefix. Keep `COMPOSE_PROJECT_NAME` and
host paths stable. `docker compose down` preserves named volumes;
`docker compose down -v` deletes them.

PostgreSQL holds reviews, access control, queue delivery, and progress. Queue rows
have seven-day retention, including completed jobs. Progress stores the first
500 events per attempt and stays until its review is deleted. Saved results and
metrics survive queue cleanup. A database backup does not include indexer files
or runner identity.

Repository tokens, UI-created webhook secrets, AI reviewer API keys, and connected
MCP credentials are stored as plaintext in PostgreSQL. Protect backups as secrets.
Index access tokens and runner bearer credentials are hashed in the database;
runner hosts also need their private identity file.

## Database setup and upgrades

Compose initializes PostgreSQL 17 and runs migrations at startup. Set distinct
passwords in `.env`:

- `RAZBOR_DB_BOOTSTRAP_PASSWORD` for initialization and extensions.
- `RAZBOR_DB_MIGRATION_PASSWORD` for schema changes.
- `RAZBOR_DB_RUNTIME_PASSWORD` for ordinary application access.

Generate URL-safe values with `openssl rand -hex 32`. Editing `.env` does not
change passwords in an existing database; rotate database and service credentials
together.

To apply pending migrations manually:

```sh
docker compose run --rm migrate
```

This applies base SQL, pg-boss schema setup, and embedding migrations. The
migration role manages schemas; the runtime role only accesses data. Use the
checked-in migrations rather than a schema push or reset. Back up before
upgrades and stop old workers before changing their dependencies or protocol.

The host CLI reads `RAZBOR_DATABASE_URL` or `RAZBOR_DATABASE_URL_FILE` for
runtime access. Migrations use `RAZBOR_MIGRATION_DATABASE_URL` or its `_FILE`
variant. A private URL file should have mode `0600`. The CLI does not load `.env`,
and Compose does not publish PostgreSQL, so prefer
`docker compose run --rm manage ...` for administration.

### Upgrade from the Redis queue

Older deployments used BullMQ/Redis. The current stack uses pg-boss in PostgreSQL;
queue execution remains in the web broker, and runners still use authenticated
HTTP without database credentials.

1. Pause review requests. Keep the old stack running until queued and active work
   finishes, including failed or delayed jobs. Pending BullMQ jobs are not imported.
2. Drain runners, stop web, runner, and indexer writers, then back up the database
   and files. Retain the Redis volume and old software for rollback.
3. Stop Redis with the old Compose file, install the new revision's dependencies,
   and run `docker compose run --rm migrate` with migration credentials. Never
   run both brokers at once.
4. Start with `docker compose up -d`, restore runner availability, and verify a
   review before reopening requests.

Completed review results remain in PostgreSQL; old Redis progress logs are not
copied. Removing the service does not delete its volume. Keep its backup until
you accept the new deployment. Rollback needs the matching database backup and
old software, not just the old image.

## Back up before changing persistent data

Pause incoming requests, finish queued and active work, and drain runners. Stop
writers before copying files:

```sh
docker compose stop web runner indexer
```

Choose a protected directory outside the checkout. Set storage paths to their
actual `.env` values; Compose does not export them to your shell.

```sh
umask 077
export RAZBOR_BACKUP_DIR=/absolute/private/path/razbor-backup
export RAZBOR_INDEX_DATA=/absolute/path/to/index-data
export RAZBOR_STORAGE_HOST=/absolute/path/to/jobs
mkdir -p "$RAZBOR_BACKUP_DIR"

docker compose exec -T postgres pg_dump -U razbor_bootstrap razbor \
  > "$RAZBOR_BACKUP_DIR/database.sql"
tar --acls --xattrs -C "$RAZBOR_INDEX_DATA" \
  -czf "$RAZBOR_BACKUP_DIR/index-data.tar.gz" .
tar --acls --xattrs -C "$RAZBOR_STORAGE_HOST" \
  -czf "$RAZBOR_BACKUP_DIR/runner-data.tar.gz" .
cp .env "$RAZBOR_BACKUP_DIR/env"
```

Also back up private TOML/secrets and named registration/model volumes. Use a
consistent stopped snapshot for filesystem volumes and preserve ownership and
permissions. Check each command before resuming:

```sh
docker compose up -d
```

Restore with services stopped and matching database, files, credentials, and
software. Reverting an image alone is unsafe after a schema upgrade. Test a
restore on an isolated installation before relying on the backup.

## Accounts and resource ownership

The console's top-left account switcher selects a personal account or organization.
Repositories, agents, skills, MCP servers, GitHub Apps, and connections belong to
that context. Assign resources from the same context, including during super
admin support work.

| Role                   | Access                                                                                                                                    |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Super admin            | Users, runners, server OAuth configuration, and all contexts for support.                                                                 |
| Personal owner         | Their repositories, agents, skills, MCP servers, and indexes.                                                                             |
| Organization admin     | All organization resources, invitations, membership, roles, and repository grants.                                                        |
| Organization moderator | Repositories, skills, MCP servers, deletion, and member repository grants. Agents, indexes, invitations, and roles remain admin controls. |
| Organization member    | Granted repositories' pull requests and review history; may request reviews. No resource management.                                      |

Any signed-in user can create an organization and becomes its first admin. Invitations target
existing accounts and take effect when accepted. Admins choose the role and
repository grants. Members receive no repository access by default; admins and
moderators can adjust grants and retain access to all organization repositories.
Removing membership revokes organization access. Groups do not control repository
grants. Membership and access changes take effect without a restart.

Migrations rename the old instance `admin` role to `super_admin`; config and CLI
still accept `admin` as an alias. Legacy resources move to the oldest super admin's
personal context. Imports preserve existing owners. New forge registrations use
that default context; new repositories inherit their forge's context, or the
default when no forge is selected. Before bootstrap creates a super admin, unowned imports stay pending
and inaccessible to ordinary users. No database reset is needed.

## Single sign-on

Local accounts are enabled by default. To configure OpenID Connect (OIDC):

1. Copy [config/razbor.example.toml](../config/razbor.example.toml) to
   `config/razbor.local.toml`.
2. Set `RAZBOR_CONFIG_FILE=./config/razbor.local.toml` in `.env`.
3. Set the issuer, client ID, client authentication method, and `redirect_uri`.
   Register that exact callback with your identity provider. Development uses
   `http://localhost:3000/api/auth/oidc/callback`; remotely, use the public HTTPS
   origin and open Razbor at that origin.
4. Set `RAZBOR_OIDC_CLIENT_SECRET` and a separate
   `RAZBOR_OIDC_TRANSACTION_SECRET`. Generate the latter with
   `openssl rand -hex 32`. Absolute private file references are supported.
5. Enable `authentication.oidc.enabled`, map group roles, and run
   `docker compose up -d --force-recreate web`.

HTTPS is required except for loopback callbacks. `allow_http = true` permits an
HTTP identity provider in development. HTTPS needs a trusted CA.

`groups_claim` selects a claim from the verified ID token or UserInfo; UserInfo
takes precedence. Dotted paths work. Map exact groups under
`authentication.oidc.group_roles`, for example `admin = "super_admin"`.
A super admin match wins; `default_role = "user"` covers everyone else. The
provider must return the claim and grant the configured scopes. These are
instance roles; organization roles and grants are managed in Razbor. OAuth/OIDC
configuration stays in server-managed TOML.

OIDC identity uses issuer and subject, separate from local accounts even when
emails match. Names, emails, and roles update at sign-in; a role change revokes
previous sessions. Provider group changes affect access at the next sign-in or
session expiry. Super admins can disable accounts in **Users**. Organization
admins and moderators manage repository access in **Organizations**.

For OIDC-only login, set `authentication.local_enabled = false`. This rejects
existing local sessions and skips local administrator creation, so first ensure
your group mapping grants super admin access. `auto_redirect = true` sends
visitors to the provider. Logout ends the Razbor session; provider and
back-channel logout are unsupported.

## Optional file-managed registration

Normally, use **Repositories → Add repository**. For file-managed registration,
copy [forgejo.example.toml](../config/forgejo.example.toml) or
[application.example.toml](../config/application.example.toml) to a private local
file. Fill it in and set `RAZBOR_REGISTRY_CONFIG` in `.env`:

```sh
pnpm run manage config check config/application.local.toml
docker compose --profile registry-import run --rm registry
docker compose run --rm manage repository list
docker compose run --rm manage repository verify forgejo-example
```

Replace `forgejo-example` with your forge key. The offline check neither resolves
secrets nor contacts providers. Import registers records; verification makes a
provider read, without proving publish permission.

For file-based Forgejo credentials, point `RAZBOR_FORGEJO_TOKEN_FILE` and
`RAZBOR_WEBHOOK_SECRET_FILE` at private host files. Compose mounts them as
`/forge-secrets/razbor.forgejo.token` and
`/forge-secrets/razbor.webhook.secret`. Other secret references need explicit
mounts or environment configuration.

Keep registry and repository keys stable to preserve identities and history.
Imports retain missing entries and only run explicitly. Remove registrations
from the file when no longer needed; importing later can recreate a deleted one.

### Change an existing checkout to HTTPS

Updating a registry URL does not update cached remotes or UI registrations that
copied its old Git policy:

1. Drain reviews, stop runner and indexer, and back up.
2. Update all affected registrations, including UI-created ones. Keep IDs,
   branch/ref policy, history, and grants. Repository and persistent-workspace
   policy snapshots must agree.
3. With services stopped, run `git remote set-url origin URL` in each affected
   service-owned checkout, using its exact HTTPS clone URL.
4. Import file-managed changes, restart, verify connections, and refresh indexes
   before resuming reviews.

Use the bot login as HTTPS username and a private token reference. Keep SSH mounts
and credentials until conversion finishes. Do not delete database or index volumes.

## Token and workspace management

Use **Indexer → Generate token** for client setup. For CLI administration:

```sh
docker compose run --rm manage index list local-indexer
docker compose run --rm manage token list local-indexer
docker compose run --rm manage token revoke tok_ABCDEFGHIJKLMNOP
```

Use IDs from the output. Save a new single-workspace token's one-time secret to a
private file:

```sh
umask 077
docker compose run --rm manage \
  token create idx_ABCDEFGHIJKLMNOP local-indexer --refresh \
  > /absolute/private/path/mcp-token.json
```

An optional lifetime in milliseconds goes after the owner and before `--refresh`,
in the range 1000–31536000000. Omit it for no expiry. Omit `--refresh` for
query-only access. Public IDs such as `repo_`, `rev_`, `idx_`, and `tok_` are
distinct from configuration aliases and bearer secrets.

## Recover after a service failure

Restart the app broker, indexer, and an eligible enrolled runner. The app rebuilds
missing pg-boss jobs from unfinished database reviews. Completed results remain.
A crash can repeat model work; execution is not exactly once.

Runners sharing a database must use one logical queue. Preserve source history
and indexer owner/storage. After an indexer restart, refresh or first-review
preparation makes saved indexes queryable again. For lost runner credentials or a
database reset, see [runner recovery](runner.md#after-deliberately-resetting-the-database).

Delete repositories through **Settings → Delete repository**. Razbor blocks new
work, then removes the webhook, indexes, credentials, and local history. Retry an
interrupted cleanup; repair credentials if webhook removal fails. The upstream
repository and published comments remain.

## Import a legacy indexer

This applies only to old TOML containing repository policy and token hashes,
`revoked-tokens.json`, and `development/<configuration-key>` directories.

1. Stop submissions, drain runners, and clean temporary reviews using the legacy
   service. Import rejects a nonempty legacy `reviews` directory.
2. Stop all processes using the storage. Back up the old TOML, index directory,
   and database.
3. Run migrations and import a registry with matching keys, Git policy,
   `persistent = true`, and indexer owner.
4. Preserve the old TOML for import. Its `data_root` must name the mounted
   container path, usually `/index-data`.

Set `RAZBOR_INDEX_CONFIG` to the absolute legacy TOML path and
`RAZBOR_INDEX_DATA` to the host data directory. Dry-run first:

```sh
docker compose run --rm \
  --user "${RAZBOR_UID:-1000}:${RAZBOR_GID:-1000}" \
  --volume "$RAZBOR_INDEX_CONFIG:/legacy/indexer.toml:ro" \
  --volume "$RAZBOR_INDEX_DATA:/index-data" \
  manage index import /legacy/indexer.toml
```

After checking the result and backups, create a private writable reports directory
outside the checkout and set `RAZBOR_IMPORT_REPORTS` to its absolute path:

```sh
docker compose run --rm \
  --user "${RAZBOR_UID:-1000}:${RAZBOR_GID:-1000}" \
  --volume "$RAZBOR_INDEX_CONFIG:/legacy/indexer.toml:ro" \
  --volume "$RAZBOR_INDEX_DATA:/index-data" \
  --volume "$RAZBOR_IMPORT_REPORTS:/reports" \
  manage index import /legacy/indexer.toml --apply --mapping /reports/cutover.json
```

Import preserves checkouts, token secrets, and revocations, but not BullMQ-only
review history. The mapping relates old identifiers to public IDs and never
overwrites a report. If writing fails after database import, rerun with a new path.

Create a runtime TOML with machine settings only; remove legacy `repositories`
and `tokens` sections from that new file. Start the new indexer, update management
URLs to mapped IDs, and refresh. Never run the legacy writer on converted data.
Rollback requires matching database and file backups.

See [tests/README.md](../tests/README.md) for validation commands and prerequisites.
