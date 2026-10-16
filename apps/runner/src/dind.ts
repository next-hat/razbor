import { spawn } from "node:child_process";
import { chown, chmod, mkdir } from "node:fs/promises";
import path from "node:path";

import Docker from "dockerode";

import { loadConfig } from "@runner/src/config.js";

const command = process.argv.slice(2);

const file = command.includes("--config")
  ? command[command.indexOf("--config") + 1]
  : undefined;

const config = await loadConfig(file);

if (
  config.docker.socket !== "/var/run/docker.sock" ||
  config.docker.runtime !== "runc" ||
  config.docker.container_id_env ||
  config.hostRoot !== config.storage.root
)
  throw new Error(
    "DinD requires its local socket, runc agents, identical storage roots and no outer container identity",
  );

const docker = new Docker({ socketPath: config.docker.socket });

await mkdir(config.storage.root, { recursive: true });
await chown(config.storage.root, config.docker.uid, config.docker.gid);
await chown(config.docker.socket, 0, config.docker.gid);
await chmod(config.docker.socket, 0o660);

await docker
  .getNetwork(config.network)
  .inspect()
  .catch(async (error) => {
    if (error.statusCode !== 404) throw error;
    await docker.createNetwork({
      Name: config.network,
      Driver: "bridge",
      Internal: true,
    });
  });

// This volume belongs to the nested daemon and binds the dependency mount inside
// the VM. Host Docker volume names and host filesystem paths never reach agents.
const dependencyPath = path.join(config.storage.runtime_root, "node_modules");

await docker.createVolume({
  Name: config.dependenciesVolume,
  Driver: "local",
  DriverOpts: { type: "none", o: "bind", device: dependencyPath },
});

const volume = await docker.getVolume(config.dependenciesVolume).inspect();

if (volume.Options?.device !== dependencyPath || volume.Options?.o !== "bind")
  throw new Error("nested dependency volume does not match the runner mount");

await docker
  .getImage(config.docker.image)
  .inspect()
  .catch(async (error) => {
    if (error.statusCode !== 404) throw error;
    console.log(
      "Pulling the configured agent image into the nested Docker daemon",
    );
    const stream = await docker.pull(config.docker.image);
    await new Promise<void>((resolve, reject) => {
      docker.modem.followProgress(
        stream,
        (failure) => (failure ? reject(failure) : resolve()),
        (event) => {
          if (["Pull complete", "Download complete"].includes(event.status))
            console.log(`Agent image layer ${event.id}: ${event.status}`);
        },
      );
    });
  });

const runner = spawn(
  "setpriv",
  [
    "--reuid",
    String(config.docker.uid),
    "--regid",
    String(config.docker.gid),
    "--clear-groups",
    "--bounding-set=-all",
    "--no-new-privs",
    "--",
    ...command,
  ],
  { stdio: "inherit" },
);

for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.once(signal, () => runner.kill(signal));

runner.once("error", () => {
  process.exitCode = 1;
});
runner.once("exit", (code) => {
  process.exitCode = code ?? 1;
});
