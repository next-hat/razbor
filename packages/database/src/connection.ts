import { readFile } from "node:fs/promises";

import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";

import * as schema from "@database/src/schema.js";
import { retryPublicIdCollision } from "@database/src/ids.js";

/**
 * Resolve the runtime or migration connection from its environment reference,
 * preferring a secret file and rejecting missing configuration.
 */
export async function databaseUrl(migration = false) {
  const name = migration
    ? "RAZBOR_MIGRATION_DATABASE_URL"
    : "RAZBOR_DATABASE_URL";
  const value = process.env[`${name}_FILE`]
    ? (await readFile(process.env[`${name}_FILE`]!, "utf8")).trim()
    : process.env[name];
  if (!value) throw new Error("database connection reference required");
  return value;
}

/**
 * Create a bounded PostgreSQL pool and database facade with collision-safe
 * transactions and an explicit readiness check.
 */
export function connectDatabase(url: string) {
  const pool = new pg.Pool({
    connectionString: url,
    max: 8,
    connectionTimeoutMillis: 3000,
    idleTimeoutMillis: 30000,
    statement_timeout: 10000,
    query_timeout: 12000,
    idle_in_transaction_session_timeout: 15000,
  });
  pool.on("error", () => console.error("Application database unavailable"));
  const db = drizzle(pool, { schema });
  return {
    db,
    pool,
    /** Drain and close the PostgreSQL pool. */
    close: () => pool.end(),
    /**
     * Run an atomic operation, retrying only recognized public identifier
     * collisions.
     */
    transaction: <T>(operation: (tx: Transaction) => Promise<T>) =>
      retryPublicIdCollision(() => db.transaction(operation)),
    /**
     * Reject privileged runtime roles and verify that the review schema is
     * accessible.
     */
    async ready() {
      const r = await pool.query<{
        rolsuper: boolean;
        rolcreatedb: boolean;
        rolcreaterole: boolean;
      }>(
        "select rolsuper, rolcreatedb, rolcreaterole from pg_roles where rolname = current_user",
      );
      if (!r.rows[0] || Object.values(r.rows[0]).some(Boolean))
        throw new Error("runtime database role must be unprivileged");
      await pool.query("select id from reviews limit 0");
    },
  };
}

export type Database = ReturnType<typeof connectDatabase>;

export type Transaction = Parameters<
  Parameters<ReturnType<typeof drizzle<typeof schema>>["transaction"]>[0]
>[0];
