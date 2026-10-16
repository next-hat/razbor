import path from "node:path";
import { realpath, readdir } from "node:fs/promises";

import Docker from "dockerode";

import { publicIdSchema } from "@razbor/contracts";

import { PermanentError } from "@runner/src/errors.js";
import type { ResolvedConfig } from "@runner/src/config.js";
import { removeWorkspace, type Workspace } from "@runner/src/workspace.js";

/** Identify containers owned by this runner for creation and restart reconciliation. */
export const ownerLabels = (c: ResolvedConfig) => ({
  "razbor.application": "razbor",
  "razbor.runner": c.runner.name,
});

/**
 * Verify the Docker runtime, image, dependency volume, internal network, and storage
 * mapping; return the relay address reachable from agents.
 */
export async function preflight(c: ResolvedConfig, docker: Docker) {
  const info = await docker.info().catch(() => {
    throw new PermanentError("Docker is inaccessible at the configured socket");
  });
  if (!Object.hasOwn(info.Runtimes ?? {}, c.docker.runtime))
    throw new PermanentError("selected Docker runtime is unavailable");
  await docker
    .getImage(c.docker.image)
    .inspect()
    .catch(() => {
      throw new PermanentError(
        "configured agent image is unavailable; pull it before starting the runner",
      );
    });
  await docker
    .getVolume(c.dependenciesVolume)
    .inspect()
    .catch(() => {
      throw new PermanentError("configured dependency volume is unavailable");
    });
  const network = await docker.getNetwork(c.network).inspect();
  if (!network.Internal || network.Driver !== "bridge")
    throw new PermanentError("job network must be an internal bridge");
  let relayHost = c.docker.relay_host;
  if (c.docker.container_id_env) {
    const self = process.env[c.docker.container_id_env];
    if (!self) throw new PermanentError("missing runner container identity");
    const inspected = await docker.getContainer(self).inspect();
    const storage = inspected.Mounts.find(
      (m) => m.Destination === c.storage.root,
    );
    const dependencies = inspected.Mounts.find(
      (m) => m.Destination === `${c.storage.runtime_root}/node_modules`,
    );
    if (
      storage?.Type !== "bind" ||
      storage.Source !== c.hostRoot ||
      !storage.RW
    )
      throw new PermanentError(
        "storage host/container mapping does not match Docker mount",
      );
    if (dependencies?.Name !== c.dependenciesVolume || dependencies.RW)
      throw new PermanentError(
        "dependency volume must match runner's read-only mount",
      );
    relayHost = inspected.NetworkSettings.Networks[c.network]?.IPAddress;
  } else if (
    (await realpath(c.storage.root)) !== (await realpath(c.hostRoot))
  ) {
    throw new PermanentError(
      "standalone runner requires identical host/storage roots",
    );
  }
  // In DinD the runner is on the daemon host, reachable at the inner bridge gateway.
  relayHost ??= network.IPAM?.Config?.[0]?.Gateway;
  if (!relayHost || relayHost === "127.0.0.1")
    throw new PermanentError("job-reachable relay IP is required");
  return relayHost;
}

/**
 * Build a non-root, resource-limited agent container with read-only source and runtime
 * mounts, writable attempt output, and scoped relay credentials.
 */
export function containerOptions(
  c: ResolvedConfig,
  w: Workspace,
  reviewId: string,
  relayHost: string,
  token: string,
): Docker.ContainerCreateOptions {
  /** Map an attempt-relative host path to its sandbox mount with explicit write access. */
  const bind = (source: string, target: string, readOnly: boolean) => ({
    Type: "bind" as const,
    Source: path.join(w.host, source),
    Target: target,
    ReadOnly: readOnly,
  });
  return {
    name: `razbor-${c.runner.name}-${w.id}`,
    Image: c.docker.image,
    User: `${c.docker.uid}:${c.docker.gid}`,
    WorkingDir: "/app",
    Cmd: [
      "node",
      "--import=tsx",
      "apps/agent/src/index.ts",
      "--job",
      "/input/job.json",
      "--output",
      "/output/result.json",
    ],
    Env: [
      `LLM_BASE_URL=http://${relayHost}:${c.model.relay_port}/v1`,
      `LLM_MODEL=${c.model.model}`,
      `LLM_PROVIDER=${c.model.provider}`,
      `LLM_API_KEY=${token}`,
      `LLM_REASONING_EFFORT=${c.model.reasoning_effort}`,
      "HOME=/tmp",
      "TMPDIR=/tmp",
      "NODE_ENV=development",
      `RAZBOR_RUNNER_ID=${c.runner.name}`,
      `RAZBOR_ATTEMPT_ID=${w.id}`,
      ...(w.mcpToken ? [`RAZBOR_MCP_TOKEN=${token}`] : []),
      ...(w.memoryEnabled ? [`RAZBOR_MEMORY_TOKEN=${token}`] : []),
    ],
    Labels: {
      ...ownerLabels(c),
      "razbor.job": reviewId,
      "razbor.attempt": w.id,
    },
    HostConfig: {
      Runtime: c.docker.runtime,
      NetworkMode: c.network,
      Privileged: false,
      ReadonlyRootfs: true,
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges:true"],
      NanoCpus: Math.round(c.docker.cpus * 1e9),
      Memory: c.docker.memory_mb * 1024 * 1024,
      MemorySwap: c.docker.memory_mb * 1024 * 1024,
      PidsLimit: c.docker.pids,
      RestartPolicy: { Name: "no" },
      Tmpfs: { "/tmp": "rw,nosuid,nodev,noexec,size=64m,mode=1777" },
      LogConfig: {
        Type: "json-file",
        Config: { "max-size": "1m", "max-file": "1" },
      },
      Mounts: [
        bind("app", "/app", true),
        ...(w.ripgrepAvailable
          ? [bind("app/bin/rg", "/usr/bin/rg", true)]
          : []),
        {
          Type: "volume",
          Source: c.dependenciesVolume,
          Target: "/app/node_modules",
          ReadOnly: true,
          VolumeOptions: {
            NoCopy: true,
            Labels: {},
            DriverConfig: { Name: "local", Options: {} },
          },
        },
        bind("repository", "/workspace/repository", true),
        bind("input", "/input", true),
        bind("output", "/output", false),
      ],
    },
  };
}

/**
 * Remove containers and validated attempt directories left by this runner identity. The
 * caller must hold the identity lock before invoking cleanup.
 */
export async function reconcile(c: ResolvedConfig, docker: Docker) {
  // Identity is operator-exclusive, enforced locally by a lifetime flock.
  const containers = await docker.listContainers({
    all: true,
    filters: {
      label: Object.entries(ownerLabels(c)).map(([k, v]) => `${k}=${v}`),
    },
  });
  for (const container of containers)
    await docker.getContainer(container.Id).remove({ force: true });
  const root = path.join(c.storage.root, c.runner.name);
  for (const id of await readdir(root)) {
    if (publicIdSchema("attempt").safeParse(id).success)
      await removeWorkspace(c, {
        id,
        root: path.join(root, id),
        host: "",
        repository: "",
      });
  }
}
