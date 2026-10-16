import { connectDatabase, databaseUrl, type Database } from "@razbor/database";
import { logger } from "@razbor/harness/logger";

import { loadIndexerConfig, managementSecret } from "@indexer/src/config.js";
import { IndexService } from "@indexer/src/service.js";

const args = process.argv.slice(2);

if (args.length !== 2 || args[0] !== "--config")
  throw new Error(
    "Usage: node --import=tsx apps/indexer/src/index.ts --config PATH",
  );

let service: IndexService | undefined;

let database: Database | undefined;

/**
 * Close the index service before its database connection, enforcing a hard shutdown deadline
 * and marking cleanup failures in the exit status.
 */
async function stop() {
  const timer = setTimeout(() => process.exit(1), 30000).unref();
  try {
    await service?.close();
  } catch {
    logger.error("index service cleanup failed");
    process.exitCode = 1;
  } finally {
    await database?.close();
    clearTimeout(timer);
  }
}

process.once("SIGINT", () => void stop());

process.once("SIGTERM", () => void stop());

try {
  const config = await loadIndexerConfig(args[1]);
  database = connectDatabase(await databaseUrl());
  service = new IndexService(config, await managementSecret(config), database);
  await service.listen();
} catch {
  logger.error(
    "index service startup failed; check operator configuration, bundle and data storage",
  );
  await stop();
  process.exitCode = 1;
}
