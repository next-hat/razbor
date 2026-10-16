import { connectDatabase, databaseUrl, type Database } from "@razbor/database";

const globalDatabase = globalThis as typeof globalThis & {
  razborDatabase?: Promise<Database>;
  razborDatabaseShutdown?: boolean;
};

/**
 * Reuses a process-global database connection, retries failed initialization, and
 * verifies readiness before returning it.
 */
export async function reviewDatabase() {
  globalDatabase.razborDatabase ??= databaseUrl()
    .then(connectDatabase)
    .catch((error: unknown) => {
      globalDatabase.razborDatabase = undefined;
      throw error;
    });
  const database = await globalDatabase.razborDatabase;
  if (!globalDatabase.razborDatabaseShutdown) {
    globalDatabase.razborDatabaseShutdown = true;
    /**
     * Starts closing the shared database when the process receives a shutdown signal.
     */
    const close = () => {
      void database.close();
    };
    process.once("SIGTERM", close);
    process.once("SIGINT", close);
  }
  await database.ready();
  return database;
}
