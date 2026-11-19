import { fileURLToPath } from "node:url";

import pg from "pg";
import { PgBoss } from "pg-boss";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate as runMigrations } from "drizzle-orm/node-postgres/migrator";
import { readMigrationFiles } from "drizzle-orm/migrator";

/**
 * Fill the GitLab boundary migration missing from the two published merge-policy
 * preview histories. Drizzle normally runs only migrations above its last timestamp.
 * The caller holds the migrator lock. Exact installed hashes identify these branches.
 */
async function reconcileMergePreview(
  client: pg.Client,
  migrationsFolder: string,
) {
  const table = await client.query(
    "select to_regclass('drizzle.__drizzle_migrations') as installed",
  );
  if (!table.rows[0].installed) return;
  const history = await client.query<{ hash: string; created_at: string }>(
    "select hash, created_at from drizzle.__drizzle_migrations where created_at in (1790000000031,1790000000032,1790000000034)",
  );
  const original = history.rows.some(
    (row) =>
      row.created_at === "1790000000031" &&
      row.hash ===
        "7708f6b258ac9c27160054b61e554311e97110557368b43f2475f208d96d7dbd",
  );
  const policyHash =
    "9de4684b72728e55f6795ea906a1664c0e753a0dd786cb796a9459d869e1a51c";
  const boundaryHash =
    "7d712b4f6b4633bd26adb8dad343ec24f23325855a96b8c5121f8ff428e18e43";
  const restacked = history.rows.some(
    (row) => row.created_at === "1790000000034" && row.hash === policyHash,
  );
  const at32 = history.rows.filter((row) => row.created_at === "1790000000032");
  if (
    at32.some(
      (row) =>
        row.hash !== boundaryHash &&
        !(
          original &&
          row.hash ===
            "e68728741aae93814e4cf6bc79f1e38834139d010688ab9b3fef14f66d4169e0"
        ),
    )
  )
    throw new Error("Unrecognized migration history at 0032");
  if (
    at32.some((row) => row.hash === boundaryHash) ||
    (!original && !restacked)
  )
    return;

  const migrations = readMigrationFiles({ migrationsFolder });
  // The first preview lacks the deferred-open columns used by GitLab boundaries.
  // Its published policy transition installs precisely those prerequisites.
  const missing =
    original && !restacked ? [policyHash, boundaryHash] : [boundaryHash];
  await client.query("begin");
  try {
    for (const hash of missing) {
      const entry = migrations.find((migration) => migration.hash === hash);
      if (!entry) throw new Error("Published preview migration SQL is missing");
      for (const statement of entry.sql) await client.query(statement);
      // Preserve every original journal row, including a preview-only hash at 0032.
      await client.query(
        "insert into drizzle.__drizzle_migrations (created_at, hash) values ($1, $2)",
        [entry.folderMillis, entry.hash],
      );
    }
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
}

/**
 * Apply review and pg-boss migrations under one database advisory lock. Queue
 * installation uses the migrator connection; runtime roles receive data access
 * without schema creation or migration authority.
 */
export async function migrate(url: string) {
  const client = new pg.Client({
    connectionString: url,
    connectionTimeoutMillis: 5000,
    statement_timeout: 60000,
    lock_timeout: 30000,
  });
  await client.connect();
  try {
    await client.query("select pg_advisory_lock(748321, 1)");
    const migrationsFolder = fileURLToPath(
      new URL("../migrations", import.meta.url),
    );
    await reconcileMergePreview(client, migrationsFolder);
    await runMigrations(drizzle(client), { migrationsFolder });
    await migrateQueue(client);
  } finally {
    await client.end();
  }
}

/**
 * Install or upgrade pg-boss and the configured review queue using the connection
 * that already holds the migration lock. Runtime connections must disable pg-boss
 * migrations and queue creation. Missing deployment runtime roles are left alone
 * for local installations that manage their own access grants.
 */
async function migrateQueue(client: pg.Client) {
  const boss = new PgBoss({
    schema: "pgboss",
    supervise: false,
    schedule: false,
    registerInstance: false,
    db: {
      /** Keep every pg-boss installation statement on the locked connection. */
      executeSql: (text, values) => client.query(text, values),
    },
  });
  // Fail migration through its promise without printing database connection data.
  boss.on("error", () => {});
  try {
    await boss.start();
    await boss.createQueue(process.env.REVIEW_QUEUE || "reviews", {
      policy: "exclusive",
      retryLimit: 2,
      retryDelay: 2,
      retryBackoff: true,
      heartbeatSeconds: 30,
      expireInSeconds: 86400,
      retentionSeconds: 604800,
      deleteAfterSeconds: 604800,
    });
    await client.query(`
      REVOKE ALL ON SCHEMA pgboss FROM PUBLIC;
      REVOKE ALL ON ALL FUNCTIONS IN SCHEMA pgboss FROM PUBLIC;
      DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'razbor_runtime') THEN
          GRANT USAGE ON SCHEMA pgboss TO razbor_runtime;
          GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA pgboss TO razbor_runtime;
          GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA pgboss TO razbor_runtime;
          GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pgboss TO razbor_runtime;
          -- BAM commands are executed by a later migrator, never by runtime.
          REVOKE INSERT, UPDATE, DELETE ON TABLE pgboss.bam, pgboss.version FROM razbor_runtime;
          GRANT UPDATE (flow_on, monitor_backoff_on) ON TABLE pgboss.version TO razbor_runtime;
        END IF;
      END $$;
    `);
  } finally {
    await boss.stop({ graceful: false });
  }
}

/**
 * Apply optional embedding migrations under the migration lock, requiring the
 * base schema and a preinstalled public vector extension.
 */
export async function migrateEmbeddings(url: string) {
  const client = new pg.Client({
    connectionString: url,
    connectionTimeoutMillis: 5000,
    statement_timeout: 60000,
    lock_timeout: 30000,
  });
  await client.connect();
  try {
    await client.query("select pg_advisory_lock(748321, 1)");
    const extension = await client.query(
      `select 1 from pg_extension e join pg_namespace n on n.oid = e.extnamespace
       where e.extname = 'vector' and n.nspname = 'public'`,
    );
    if (!extension.rowCount)
      throw new Error(
        "a database administrator must install the vector extension in public before embedding migrations",
      );
    const base = await client.query<{ ready: boolean }>(
      "select to_regclass('public.index_workspaces') is not null as ready",
    );
    if (!base.rows[0]?.ready)
      throw new Error(
        "run base database migrations before embedding migrations",
      );
    await runMigrations(drizzle(client), {
      migrationsFolder: fileURLToPath(
        new URL("../embedding-migrations", import.meta.url),
      ),
      migrationsTable: "__drizzle_embeddings_migrations",
    });
  } finally {
    await client.end();
  }
}
