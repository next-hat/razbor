import { randomBytes, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import Docker from "dockerode";
import pg from "pg";

import { connectDatabase } from "@razbor/database";
import { migrate } from "@razbor/database/migrate";

/** Create isolated PostgreSQL roles, apply application and queue migrations, and return clients and cleanup. */
export async function databaseFixture() {
  const docker = new Docker();
  const name = `razbor-state-test-${randomUUID()}`;
  const password = randomBytes(24).toString("hex");
  const migrationPassword = randomBytes(24).toString("hex");
  const runtimePassword = randomBytes(24).toString("hex");
  const containers: Docker.Container[] = [];
  const network = await docker.createNetwork({
    Name: name,
    Internal: true,
    Driver: "bridge",
  });
  let database: ReturnType<typeof connectDatabase> | undefined;
  let administrator: pg.Client | undefined;
  try {
    const container = await docker.createContainer({
      Image: "postgres:17-alpine",
      name,
      Env: [`POSTGRES_PASSWORD=${password}`, "POSTGRES_DB=razbor"],
      HostConfig: { NetworkMode: name },
      Labels: { "razbor.test": name },
    });
    containers.push(container);
    await container.start();
    const host = (await container.inspect()).NetworkSettings.Networks[name]
      .IPAddress;
    const adminUrl = `postgresql://postgres:${password}@${host}:5432/razbor`;
    for (let i = 0; i < 100; i++) {
      const client = new pg.Client({
        connectionString: adminUrl,
        connectionTimeoutMillis: 500,
      });
      try {
        await client.connect();
        administrator = client;
        client.on("error", () => {});
        break;
      } catch {
        await client.end();
        await delay(100);
      }
    }
    if (!administrator)
      throw new Error("isolated PostgreSQL did not become ready");
    // Passwords are generated hex strings, never external interpolation or logged.
    await administrator.query(
      `CREATE ROLE razbor_migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '${migrationPassword}'`,
    );
    await administrator.query(
      `CREATE ROLE razbor_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '${runtimePassword}'`,
    );
    await administrator.query(
      "ALTER DATABASE razbor OWNER TO razbor_migrator; ALTER SCHEMA public OWNER TO razbor_migrator; REVOKE CREATE ON SCHEMA public FROM PUBLIC; GRANT USAGE ON SCHEMA public TO razbor_runtime; ALTER DEFAULT PRIVILEGES FOR ROLE razbor_migrator IN SCHEMA public GRANT SELECT,INSERT,UPDATE,DELETE ON TABLES TO razbor_runtime",
    );
    const migrationUrl = `postgresql://razbor_migrator:${migrationPassword}@${host}:5432/razbor`;
    const url = `postgresql://razbor_runtime:${runtimePassword}@${host}:5432/razbor`;
    await Promise.all([migrate(migrationUrl), migrate(migrationUrl)]);
    database = connectDatabase(url);
    await database.ready();
    return {
      database,
      url,
      migrationUrl,
      container,
      networkName: name,
      administrator,
      /** Close both database clients, remove fixture containers and their volumes, then remove the private network. */
      async close() {
        await database?.close();
        await administrator?.end();
        containers.reverse();
        for (const c of containers) await c.remove({ force: true, v: true });
        await network.remove();
      },
    };
  } catch (error) {
    await database?.close();
    await administrator?.end();
    containers.reverse();
    for (const c of containers)
      await c.remove({ force: true, v: true }).catch(() => {});
    await network.remove();
    throw error;
  }
}
