import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";

import {
  connectDatabase,
  type Database,
  databaseUrl,
  resolveRepository,
  listRepositories,
  listTokens,
  issueToken,
  revokeToken,
  ownedWorkspaces,
  applyWebhookSettings,
  RunnerInputError,
} from "@razbor/database";
import { migrate, migrateEmbeddings } from "@razbor/database/migrate";
import {
  loadRegistry,
  applyRegistry,
  refreshRepository,
} from "@razbor/database/registry";
import { importLegacy } from "@razbor/database/legacy";
import { loadIndexerConfig } from "@razbor/indexer/config";

import { provisionRunnerConfig } from "./provision-runner.js";

/**
 * Run migrations or validate registry configuration before opening the runtime database.
 * Returns whether this command was handled; unsupported commands fall through to main.
 */
async function standaloneCommand(
  resource: string,
  command: string,
  args: string[],
) {
  if (
    resource === "database" &&
    command === "migrate-embeddings" &&
    !args.length
  ) {
    await migrateEmbeddings(await databaseUrl(true));
    console.log("Optional embedding migrations completed.");
    return true;
  }
  if (resource === "database" && command === "migrate" && !args.length) {
    await migrate(await databaseUrl(true));
    console.log("Database migrations completed.");
    return true;
  }
  if (resource === "config" && command === "check" && args.length === 1) {
    const config = await loadRegistry(args[0]);
    console.log(
      JSON.stringify({
        valid: true,
        forges: Object.keys(config.forges).length,
        repositories: Object.keys(config.repositories).length,
      }),
    );
    return true;
  }
  return false;
}

/**
 * Preview or apply legacy index state while holding the indexer's storage lock.
 * Optional ID mappings are written exclusively to a private file; active storage aborts the import.
 */
async function importIndex(database: Database, args: string[]) {
  const config = await loadIndexerConfig(args[0]);
  const apply = args.includes("--apply");
  const mapping = args.indexOf("--mapping");
  if (
    args
      .slice(1)
      .some(
        (arg, i) =>
          arg !== "--apply" && arg !== "--mapping" && i + 1 !== mapping + 1,
      ) ||
    (mapping !== -1 && (!apply || !args[mapping + 1]))
  )
    throw new Error("invalid import options");
  const guard = spawn(
    "flock",
    [
      "--nonblock",
      path.join(config.service.data_root, "service.lock"),
      process.execPath,
      "-e",
      'process.stdout.write("ready");process.stdin.resume()',
    ],
    { stdio: ["pipe", "pipe", "ignore"] },
  );
  try {
    await new Promise<void>((resolve, reject) => {
      guard.once("error", reject);
      guard.once("exit", () => reject(new Error("index storage active")));
      guard.stdout.once("data", () => resolve());
    });
    const report = await importLegacy(database, config, apply);
    if (mapping !== -1)
      await writeFile(
        args[mapping + 1],
        JSON.stringify(report.mappings, null, 2),
        { mode: 0o600, flag: "wx" },
      );
    console.log(
      JSON.stringify({
        applied: report.applied,
        workspaces: report.workspaces,
        tokens: report.tokens,
        revocations: report.revocations,
      }),
    );
  } finally {
    guard.stdin.end();
  }
}

/** Issue a scoped index token with a bounded optional lifetime and print its one-time credentials. */
async function createToken(database: Database, args: string[]) {
  const ttl = args.slice(2).find((v) => v !== "--refresh");
  const ttlMs = ttl === undefined ? undefined : Number(ttl);
  if (
    ttlMs !== undefined &&
    (!Number.isSafeInteger(ttlMs) || ttlMs < 1000 || ttlMs > 31536000000)
  )
    throw new Error("invalid token lifetime");
  console.log(
    JSON.stringify(
      await issueToken(database, args[0], args[1], {
        refresh: args.includes("--refresh"),
        ttlMs,
      }),
    ),
  );
}

/** List repositories, resolve a stable ID, or refresh its remote identity for the CLI. */
async function repositoryCommand(
  database: Database,
  command: string,
  args: string[],
) {
  if (command === "list" && !args.length) {
    console.log(JSON.stringify(await listRepositories(database), null, 2));
    return;
  }
  if (!["resolve", "verify"].includes(command) || args.length !== 1)
    throw new Error("unknown administrative command");
  const id = await resolveRepository(database, args[0]);
  if (!id) throw new Error("repository unavailable");
  console.log(
    command === "resolve"
      ? id
      : JSON.stringify(await refreshRepository(database, id), null, 2),
  );
}

/** Dispatch legacy imports or print the workspaces owned by the requested index. */
async function indexCommand(
  database: Database,
  command: string,
  args: string[],
) {
  if (command === "import" && args[0]) {
    await importIndex(database, args);
    return;
  }
  if (command !== "list" || args.length !== 1)
    throw new Error("unknown administrative command");
  console.log(
    JSON.stringify(
      (await ownedWorkspaces(database, args[0])).map((w) => ({
        id: w.id,
        repositoryId: w.repositoryId,
        attemptId: w.attemptId,
        temporary: w.temporary,
        state: w.state,
        headSha: w.headSha,
        expiresAt: w.expiresAt,
      })),
      null,
      2,
    ),
  );
}

/** Dispatch token listing, revocation, or issuance after validating CLI argument counts. */
async function tokenCommand(
  database: Database,
  command: string,
  args: string[],
) {
  if (command === "list" && args.length === 1) {
    console.log(JSON.stringify(await listTokens(database, args[0]), null, 2));
  } else if (command === "revoke" && args.length === 1) {
    await revokeToken(database, args[0]);
    console.log("Token revoked.");
  } else if (command === "create" && args.length >= 2 && args.length <= 4) {
    await createToken(database, args);
  } else throw new Error("unknown administrative command");
}

/** Dispatch an administrative command and close the runtime database on success or failure. */
async function main() {
  const [resource, command, ...args] = process.argv.slice(2);
  if (await standaloneCommand(resource, command, args)) return;
  const database = connectDatabase(await databaseUrl());
  try {
    await database.ready();
    switch (resource) {
      case "config": {
        if (command !== "apply" || args.length !== 1)
          throw new Error("unknown administrative command");
        const config = await loadRegistry(args[0]);
        await applyRegistry(database, config);
        await applyWebhookSettings(database, config);
        console.log(
          "Registry applied; IDs preserved. Webhook setup reconciled; inspect repository webhook status.",
        );
        break;
      }
      case "runner":
        if (command !== "provision" || args.length !== 1)
          throw new Error("unknown administrative command");
        await provisionRunnerConfig(database, args[0]);
        break;
      case "repository":
        await repositoryCommand(database, command, args);
        break;
      case "index":
        await indexCommand(database, command, args);
        break;
      case "token":
        await tokenCommand(database, command, args);
        break;
      default:
        throw new Error("unknown administrative command");
    }
  } finally {
    await database.close();
  }
}

try {
  await main();
} catch (error) {
  // Runner validation messages are API-safe; unexpected errors can contain secrets.
  if (error instanceof RunnerInputError) console.error(error.message);
  else
    console.error(
      "Administrative operation failed. Check command, configuration, ownership, identity conflicts and service availability; no secret diagnostics are emitted. For Compose, run commands through 'docker compose run --rm manage' (for example, 'docker compose run --rm manage repository list'). The host CLI does not load .env; repository and runner administration requires an exported RAZBOR_DATABASE_URL or RAZBOR_DATABASE_URL_FILE pointing to a reachable runtime database.",
    );
  process.exitCode = 1;
}
