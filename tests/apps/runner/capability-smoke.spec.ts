import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  readdir,
  chmod,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import Docker from "dockerode";
import { stringify } from "smol-toml";

import { applyRegistry, registrySchema } from "@razbor/database/registry";
import {
  listRepositories,
  createAgent,
  assignRepositoryAgent,
  listRunners,
} from "@razbor/database";
import { createQueue } from "@razbor/queue";
import { publicIdSchema, type QueueJob } from "@razbor/contracts";
import { gitEnvironment } from "@razbor/harness/git";
import { runnerConfigSchema } from "@razbor/runner/config";

import { databaseFixture } from "@tests/packages/database/fixture.js";

const exec = promisify(execFile);

test(
  "Durable API review through a Kata DinD runner and real remote index",
  { timeout: 900000 },
  async () => {
    const bundle = process.env.RAZBOR_CBM_BUNDLE;

    if (!bundle || !path.isAbsolute(bundle))
      throw new Error(
        "set RAZBOR_CBM_BUNDLE to the provisioned v0.11.0 bundle directory",
      );

    const runtime = process.cwd();

    const root = await mkdtemp(
      path.join(os.tmpdir(), "razbor-kata-capabilities-"),
    );

    const id = `razbor-cap-${randomBytes(6).toString("hex")}`;

    const administratorUsername = `smoke-${randomBytes(6).toString("hex")}`;

    const administratorPassword = randomBytes(32).toString("hex");

    const docker = new Docker({
      socketPath: "/var/run/docker.sock",
      // Docker can delay state replies while the cold installer exits.
      timeout: 60000,
    });

    const containers: Docker.Container[] = [];

    let network: Docker.Network | undefined;

    let volume: Docker.Volume | undefined;

    let webVolume: Docker.Volume | undefined;

    let runner: Docker.Container | undefined;

    let state: Awaited<ReturnType<typeof databaseFixture>> | undefined;

    let calls = 0;

    let modelFailure: unknown;

    let failed = false;

    let failure: unknown;

    let cleanupFailure: string | undefined;

    let dependencyPhase: string | undefined;

    const mockKey = randomBytes(32).toString("hex");

    const model = createServer((req, res) => {
      void (async () => {
        assert.equal(req.url, "/v1/responses");
        assert.equal(req.headers.authorization, `Bearer ${mockKey}`);
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const input = JSON.parse(Buffer.concat(chunks).toString());
        const texts = JSON.stringify(input.input);
        assert.match(texts, /Approved fixture base instruction/);
        assert.doesNotMatch(
          input.input
            .filter((m: { role: string }) =>
              ["system", "developer"].includes(m.role),
            )
            .map((m: { content: unknown }) => JSON.stringify(m.content))
            .join("\n"),
          /Untrusted head override/,
        );
        const last = [...input.input]
          .reverse()
          .find(
            (message: { type?: string }) =>
              message.type === "function_call_output",
          );
        if (calls > 0 && calls <= 4) {
          assert.equal(last.type, "function_call_output");
          assert.equal(last.call_id, `step-${calls - 1}`);
        }
        if (calls === 1) {
          assert.match(last.output, /correctness/);
          assert.doesNotMatch(last.output, /Inspect arithmetic carefully/);
        }
        if (calls === 2)
          assert.match(last.output, /Inspect arithmetic carefully/);
        if (calls === 3) {
          assert.match(last.output, /add/);
          assert.doesNotMatch(last.output, /Tool error/);
        }
        if (calls === 4) {
          assert.match(last.output, /1 \| export function add/);
          assert.match(last.output, /a - b/);
        }
        const sequence = [
          ["find_skill", { query: "arithmetic" }],
          ["read_skill", { id: "correctness" }],
          ["cbm_search_graph", { name_pattern: "^add$" }],
          ["read_file", { path: "math.ts" }],
        ] as const;
        const stage = [
          ...texts.matchAll(
            /harness is now running the (investigate|verify|challenge) checkpoint/g,
          ),
        ].at(-1)?.[1];
        const final = texts.includes(
          "All three investigation checkpoints passed",
        );
        const sourceReads = input.input.filter(
          (message: { type?: string; name?: string }) =>
            message.type === "function_call" && message.name === "read_file",
        ).length;
        const step =
          sequence[calls] ??
          (stage === "challenge" && sourceReads === 1 && !final
            ? sequence[3]
            : undefined);
        const evidenceIds = ["tool-4", ...(sourceReads > 1 ? ["tool-5"] : [])];
        const checkpoint = {
          summary: "The inspected add implementation subtracts its arguments.",
          risks: [
            {
              id: "addition-result",
              path: "math.ts",
              contract: "add returns the arithmetic sum of its arguments.",
              trigger: "Call add(1, 2).",
              before: "The baseline returns 3 using a + b.",
              after: "The head returns -1 using a - b.",
              evidenceIds,
            },
          ],
          candidates: [
            {
              path: "math.ts",
              lineStart: 1,
              lineEnd: 1,
              scenario: "add(1, 2) produces -1.",
              status: "supported",
              evidenceIds,
            },
          ],
          unresolved: [],
          limitations: [],
        };
        const output = step
          ? {
              id: `fixture-function-${calls}`,
              type: "function_call",
              status: "completed",
              call_id: `step-${calls}`,
              name: step[0],
              arguments: JSON.stringify(step[1]),
            }
          : {
              id: "fixture-message",
              type: "message",
              status: "completed",
              role: "assistant",
              content: [
                {
                  type: "output_text",
                  text: JSON.stringify(
                    final
                      ? {
                          summary: "Fixture tools verified",
                          findings: [
                            {
                              severity: "high",
                              path: "math.ts",
                              lineStart: 1,
                              lineEnd: 1,
                              title: "Addition now subtracts",
                              body: "The inspected function subtracts its arguments.",
                              failureScenario: "add(1, 2) produces -1.",
                              suggestion: "Return a + b.",
                            },
                          ],
                        }
                      : checkpoint,
                  ),
                  annotations: [],
                },
              ],
            };
        if (step)
          assert.ok(
            input.tools.some((t: { name: string }) => t.name === step[0]),
          );
        calls++;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            id: `fixture-${calls}`,
            object: "response",
            created_at: 0,
            status: "completed",
            model: "fixture",
            output: [output],
          }),
        );
      })().catch((error) => {
        modelFailure = error;
        res.writeHead(500);
        res.end('{"error":"fixture assertion failed"}');
      });
    });

    /** Run Git against the temporary upstream with fixed author identity and optional standard input. */
    async function runGit(repository: string, args: string[], input?: string) {
      const child = exec("git", ["-C", repository, ...args], {
        env: {
          ...gitEnvironment,
          GIT_AUTHOR_NAME: "Fixture",
          GIT_AUTHOR_EMAIL: "fixture@example.invalid",
          GIT_COMMITTER_NAME: "Fixture",
          GIT_COMMITTER_EMAIL: "fixture@example.invalid",
        },
      });
      child.child.stdin?.end(input);
      return (await child).stdout.trim();
    }

    try {
      const info = await docker.info();
      assert.ok(
        Object.hasOwn(info.Runtimes ?? {}, "kata"),
        "Kata runtime is required",
      );
      await docker.getImage("node:24-bookworm").inspect();
      const runnerImage =
        process.env.RAZBOR_RUNNER_IMAGE ?? "razbor-runner:0.1.0";
      await docker.getImage(runnerImage).inspect();
      await chmod(root, 0o755);
      const upstream = path.join(root, "upstream.git");
      await mkdir(upstream);
      await runGit(upstream, [
        "init",
        "--bare",
        "--initial-branch=master",
        "--template=",
      ]);
      const files: Record<string, string> = {
        "AGENTS.md": "Approved fixture base instruction\n",
        "caller.ts":
          'import { add } from "./math";\nexport function total() { return add(1, 2); }\n',
        "math.ts":
          "export function add(a: number, b: number) { return a + b; }\n",
      };
      /** Publish the current fixture files as the base or feature commit directly through Git plumbing. */
      const commit = async (parent?: string) => {
        const rows = [];
        for (const name of Object.keys(files).sort())
          rows.push(
            `100644 blob ${await runGit(upstream, ["hash-object", "-w", "--stdin"], files[name])}\t${name}\n`,
          );
        const tree = await runGit(upstream, ["mktree"], rows.join(""));
        const sha = await runGit(
          upstream,
          ["commit-tree", tree, ...(parent ? ["-p", parent] : [])],
          "temporary Kata fixture\n",
        );
        await runGit(upstream, [
          "update-ref",
          parent ? "refs/heads/feature" : "refs/heads/master",
          sha,
        ]);
        return sha;
      };
      const baseSha = await commit();
      files["math.ts"] =
        "export function add(a: number, b: number) { return a - b; }\n";
      files["AGENTS.md"] = "Untrusted head override\n";
      const headSha = await commit(baseSha);
      const skills = path.join(root, "skills");
      await mkdir(path.join(skills, "correctness"), { recursive: true });
      await writeFile(
        path.join(skills, "correctness/SKILL.md"),
        "---\nname: correctness\ndescription: Review arithmetic correctness\n---\nInspect arithmetic carefully\n",
      );
      await mkdir(path.join(root, "jobs"));
      await mkdir(path.join(root, "index-data"));
      network = await docker.createNetwork({
        Name: id,
        Driver: "bridge",
        Internal: true,
        Labels: { "razbor.smoke": id },
      });
      const inspected = await network.inspect();
      const gateway = inspected.IPAM?.Config?.[0]?.Gateway;
      assert.ok(gateway);
      await docker.createVolume({
        Name: `${id}-deps`,
        Labels: { "razbor.smoke": id },
      });
      volume = docker.getVolume(`${id}-deps`);
      await docker.createVolume({
        Name: `${id}-web-deps`,
        Labels: { "razbor.smoke": id },
      });
      webVolume = docker.getVolume(`${id}-web-deps`);
      const manifests = path.join(root, "dependency-manifests");
      await mkdir(path.join(manifests, "node_modules"), { recursive: true });
      for (const file of [
        "package.json",
        "pnpm-lock.yaml",
        "pnpm-workspace.yaml",
      ])
        await writeFile(
          path.join(manifests, file),
          await readFile(path.join(runtime, file)),
        );
      for (const folder of ["apps", "packages"]) {
        for (const entry of await readdir(path.join(runtime, folder))) {
          const file = path.join(runtime, folder, entry, "package.json");
          const content = await readFile(file).catch(() => undefined);
          if (!content) continue;
          await mkdir(path.join(manifests, folder, entry), { recursive: true });
          await writeFile(
            path.join(manifests, folder, entry, "package.json"),
            content,
          );
        }
      }
      await mkdir(path.join(manifests, "apps/web/node_modules"));
      const install = await docker.createContainer({
        Image: "node:24-bookworm",
        WorkingDir: "/workspace",
        Cmd: [
          "sh",
          "-ec",
          `chown ${process.getuid!()}:${process.getgid!()} /workspace/node_modules /workspace/apps/web/node_modules; exec setpriv --reuid ${process.getuid!()} --regid ${process.getgid!()} --clear-groups npm exec --yes --cache /tmp/npm-cache --package=pnpm@12.11.2 -- pnpm install --frozen-lockfile --store-dir /tmp/pnpm-store`,
        ],
        Env: [
          "CI=1",
          "XDG_CONFIG_HOME=/tmp/razbor-pnpm-config",
          "XDG_DATA_HOME=/tmp/razbor-pnpm-data",
          "XDG_CACHE_HOME=/tmp/razbor-pnpm-cache",
          "XDG_STATE_HOME=/tmp/razbor-pnpm-state",
          "PNPM_HOME=/tmp/razbor-pnpm-home",
        ],
        Labels: { "razbor.smoke": id },
        HostConfig: {
          Mounts: [
            {
              Type: "bind",
              Source: manifests,
              Target: "/workspace",
            },
            {
              Type: "volume",
              Source: `${id}-deps`,
              Target: "/workspace/node_modules",
            },
            {
              Type: "volume",
              Source: `${id}-web-deps`,
              Target: "/workspace/apps/web/node_modules",
            },
          ],
        },
      });
      containers.push(install);
      console.log("Preparing isolated smoke dependencies");
      const installDeadline = Date.now() + 300000;
      const installSignal = AbortSignal.timeout(300000);
      dependencyPhase = "starting the isolated dependency installer";
      await install.start({ abortSignal: installSignal });
      dependencyPhase = "inspecting the isolated dependency installer";
      let installed = await install.inspect({ abortSignal: installSignal });
      while (installed.State.Running && Date.now() < installDeadline) {
        await delay(500);
        installed = await install.inspect({ abortSignal: installSignal });
      }
      assert.equal(
        installed.State.Running,
        false,
        "isolated pnpm install timed out",
      );
      if (installed.State.ExitCode !== 0) {
        dependencyPhase = "reading the isolated dependency installer logs";
        const logs = await install.logs({
          stdout: true,
          stderr: true,
          tail: 20,
        });
        console.error(
          Buffer.isBuffer(logs)
            ? logs.toString().slice(-8000)
            : "dependency install failed",
        );
      }
      assert.equal(installed.State.ExitCode, 0, "isolated pnpm install failed");
      console.log("Isolated dependencies ready; creating PostgreSQL fixture");
      dependencyPhase = "creating the isolated PostgreSQL fixture";
      state = await databaseFixture();
      dependencyPhase = undefined;
      await applyRegistry(
        state.database,
        registrySchema.parse({
          registry: { key: "smoke" },
          repositories: {
            fixture: {
              git: {
                branch: "master",
                upstream: "refs/remotes/origin/master",
                remotes: { origin: "file:///fixture/upstream.git" },
                allow_local: true,
              },
              indexing: { owner: "local-indexer", persistent: false },
            },
          },
        }),
      );
      const registered = (await listRepositories(state.database))[0];
      const management = randomBytes(32).toString("base64url");
      await writeFile(
        path.join(root, "indexer.toml"),
        `[service]\nhost="0.0.0.0"\nport=8790\ndata_root="/index-data"\nmanagement_token={env="RAZBOR_INDEX_MANAGEMENT_TOKEN"}\n[memory]\nexecutable="/cbm/codebase-memory-mcp"\n[repositories.fixture]\nbranch="master"\nupstream="refs/remotes/origin/master"\nremotes={origin="file:///fixture/upstream.git"}\nallow_local=true\n`,
      );
      const indexer = await docker.createContainer({
        Image: "node:24-bookworm",
        User: `${process.getuid!()}:${process.getgid!()}`,
        WorkingDir: "/workspace",
        Cmd: [
          "node",
          "--import=tsx",
          "apps/indexer/src/index.ts",
          "--config",
          "/fixture/indexer.toml",
        ],
        Env: [
          `RAZBOR_INDEX_MANAGEMENT_TOKEN=${management}`,
          `RAZBOR_DATABASE_URL=${state.url}`,
        ],
        Labels: { "razbor.smoke": id },
        HostConfig: {
          Init: true,
          NetworkMode: id,
          Mounts: [
            {
              Type: "bind",
              Source: runtime,
              Target: "/workspace",
              ReadOnly: true,
            },
            {
              Type: "volume",
              Source: `${id}-deps`,
              Target: "/workspace/node_modules",
              ReadOnly: true,
            },
            {
              Type: "bind",
              Source: path.join(manifests, "packages/database/node_modules"),
              Target: "/workspace/packages/database/node_modules",
              ReadOnly: true,
            },
            { Type: "bind", Source: root, Target: "/fixture", ReadOnly: true },
            {
              Type: "bind",
              Source: path.join(root, "index-data"),
              Target: "/index-data",
            },
            { Type: "bind", Source: bundle, Target: "/cbm", ReadOnly: true },
          ],
        },
      });
      containers.push(indexer);
      await docker
        .getNetwork(state.networkName)
        .connect({ Container: indexer.id });
      console.log("Starting isolated index service");
      await indexer.start();
      const indexIp = (await indexer.inspect()).NetworkSettings.Networks[id]
        .IPAddress;
      const indexEndpoint = `http://${indexIp}:8790`;
      let ready = false;
      for (let i = 0; i < 100; i++) {
        ready = await fetch(`${indexEndpoint}/health`, {
          headers: { Authorization: `Bearer ${management}` },
          signal: AbortSignal.timeout(1000),
        }).then(
          (r) => r.ok,
          () => false,
        );
        if (ready) break;
        await delay(200);
      }
      assert.ok(ready, "index service did not become ready");
      await new Promise<void>((resolve) => model.listen(0, "0.0.0.0", resolve));
      const modelAddress = model.address();
      assert.ok(modelAddress && typeof modelAddress !== "string");
      const reviewer = await createAgent(state.database, {
        endpoint: `http://${gateway}:${modelAddress.port}/v1/responses`,
        model: "fixture",
        apiKey: mockKey,
      });
      await assignRepositoryAgent(state.database, registered.id, reviewer.id);
      const config = runnerConfigSchema.parse({
        runner: {
          name: id,
          concurrency: 1,
          timeout_ms: 180000,
          shutdown_grace_ms: 1000,
        },
        docker: {
          image: "node:24-bookworm",
          network: "razbor_jobs",
          cpus: 2,
          memory_mb: 1024,
          pids: 128,
          uid: process.getuid!(),
          gid: process.getgid!(),
        },
        storage: {
          root: "/job-data",
          host_root: "/job-data",
          runtime_root: "/workspace",
          dependencies_volume: "razbor_dependencies",
        },
        capabilities: {
          base_instructions: true,
          skill_directories: ["/runner-assets/skills"],
        },
      });
      const portProbe = createServer();
      await new Promise<void>((resolve) =>
        portProbe.listen(0, "127.0.0.1", resolve),
      );
      const relayAddress = portProbe.address();
      assert.ok(relayAddress && typeof relayAddress !== "string");
      config.model.relay_port = relayAddress.port;
      await new Promise<void>((resolve) => portProbe.close(() => resolve()));
      const runnerFile = path.join(root, "runner.toml");
      const nextRoot = path.join(root, "next");
      await mkdir(nextRoot);
      const nextEnvironment = path.join(root, "next-env.d.ts");
      await writeFile(
        nextEnvironment,
        await readFile(path.join(runtime, "apps/web/next-env.d.ts")),
      );
      const web = await docker.createContainer({
        Image: "node:24-bookworm",
        User: `${process.getuid!()}:${process.getgid!()}`,
        WorkingDir: "/workspace/apps/web",
        Cmd: [
          "node",
          "/workspace/node_modules/next/dist/bin/next",
          "dev",
          "--webpack",
          "--hostname",
          "0.0.0.0",
        ],
        Env: [
          `RAZBOR_DATABASE_URL=${state.url}`,
          `RAZBOR_ADMIN_USERNAME=${administratorUsername}`,
          `RAZBOR_ADMIN_PASSWORD=${administratorPassword}`,
          `RAZBOR_INDEX_ENDPOINT=${indexEndpoint}`,
          `RAZBOR_INDEX_MANAGEMENT_TOKEN=${management}`,
          "NEXT_TELEMETRY_DISABLED=1",
        ],
        Labels: { "razbor.smoke": id },
        HostConfig: {
          NetworkMode: state.networkName,
          Mounts: [
            {
              Type: "bind",
              Source: runtime,
              Target: "/workspace",
              ReadOnly: true,
            },
            {
              Type: "volume",
              Source: `${id}-deps`,
              Target: "/workspace/node_modules",
              ReadOnly: true,
            },
            {
              Type: "bind",
              Source: path.join(manifests, "packages/database/node_modules"),
              Target: "/workspace/packages/database/node_modules",
              ReadOnly: true,
            },
            {
              Type: "volume",
              Source: `${id}-web-deps`,
              Target: "/workspace/apps/web/node_modules",
              ReadOnly: true,
            },
            {
              Type: "bind",
              Source: nextRoot,
              Target: "/workspace/apps/web/.next",
            },
            {
              Type: "bind",
              Source: nextEnvironment,
              Target: "/workspace/apps/web/next-env.d.ts",
            },
          ],
        },
      });
      containers.push(web);
      await network.connect({ Container: web.id });
      console.log("Starting isolated Next.js control plane");
      await web.start();
      const webIp = (await web.inspect()).NetworkSettings.Networks[id]
        .IPAddress;
      const api = `http://${webIp}:3000`;
      let webReady = false;
      for (let i = 0; i < 100; i++) {
        webReady = await fetch(`${api}/health`, {
          signal: AbortSignal.timeout(1000),
        }).then(
          (r) => r.ok,
          () => false,
        );
        if (webReady) break;
        await delay(300);
      }
      if (!webReady) {
        try {
          const logs = await web.logs({ stdout: true, stderr: true, tail: 60 });
          if (Buffer.isBuffer(logs)) {
            let output = logs.toString().slice(-12000);
            for (const secret of [
              administratorPassword,
              management,
              mockKey,
              state.url,
              decodeURIComponent(new URL(state.url).password),
            ])
              output = output.replaceAll(secret, "[redacted]");
            console.error(`Isolated Next.js startup logs:\n${output}`);
          }
        } catch {
          console.error("Could not read the isolated Next.js startup logs.");
        }
      }
      assert.ok(webReady, "Next.js API not ready");
      const login = await fetch(`${api}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: api },
        body: JSON.stringify({
          username: administratorUsername,
          password: administratorPassword,
        }),
        signal: AbortSignal.timeout(30000),
      });
      assert.equal(login.status, 200, await login.clone().text());
      const signedIn = await login.json();
      assert.equal(signedIn.user.mustChangePassword, false);
      assert.ok(signedIn.user.repositoryIds.includes(registered.id));
      const sessionCookie = login.headers
        .getSetCookie()
        .find((value) => value.startsWith("razbor_session="))
        ?.split(";", 1)[0];
      assert.ok(sessionCookie, "sign-in did not issue a session cookie");
      const authenticatedHeaders = { Cookie: sessionCookie };
      await writeFile(
        runnerFile,
        stringify({
          ...config,
          registration: { key: id, name: id, repositories: [registered.id] },
          control: {
            url: api,
            allow_http: true,
            enrollment_token: { file: "/runner-registration/state/token" },
          },
        }),
      );
      const registrationRoot = path.join(root, "runner-registration");
      await mkdir(registrationRoot);
      const provision = await docker.createContainer({
        Image: "node:24-bookworm",
        WorkingDir: "/workspace",
        Cmd: [
          "node",
          "--import=tsx",
          "scripts/manage.ts",
          "runner",
          "provision",
          "/runner-assets/runner.toml",
        ],
        Env: [`RAZBOR_DATABASE_URL=${state.url}`],
        Labels: { "razbor.smoke": id },
        HostConfig: {
          NetworkMode: state.networkName,
          Mounts: [
            {
              Type: "bind",
              Source: runtime,
              Target: "/workspace",
              ReadOnly: true,
            },
            {
              Type: "volume",
              Source: `${id}-deps`,
              Target: "/workspace/node_modules",
              ReadOnly: true,
            },
            {
              Type: "bind",
              Source: path.join(manifests, "packages/database/node_modules"),
              Target: "/workspace/packages/database/node_modules",
              ReadOnly: true,
            },
            {
              Type: "bind",
              Source: runnerFile,
              Target: "/runner-assets/runner.toml",
              ReadOnly: true,
            },
            {
              Type: "bind",
              Source: registrationRoot,
              Target: "/runner-registration",
            },
          ],
        },
      });
      containers.push(provision);
      console.log("Provisioning runner from TOML through the management CLI");
      await provision.start();
      let provisionedState = await provision.inspect();
      const provisionDeadline = Date.now() + 60000;
      while (provisionedState.State.Running && Date.now() < provisionDeadline) {
        await delay(200);
        provisionedState = await provision.inspect();
      }
      assert.equal(
        provisionedState.State.Running,
        false,
        "TOML runner provisioning timed out",
      );
      assert.equal(
        provisionedState.State.ExitCode,
        0,
        "TOML runner provisioning failed",
      );
      const provisionedRunner = (await listRunners(state.database)).find(
        (entry) => entry.name === id,
      );
      assert.ok(provisionedRunner, "TOML runner registration was not created");
      console.log("Creating enrolled Kata runner container");
      const startupDocker = new Docker({
        socketPath: "/var/run/docker.sock",
        timeout: 60000,
      });
      const runnerStartup = await startupDocker.createContainer({
        Image: runnerImage,
        name: `${id}-runner`,
        WorkingDir: "/workspace",
        Cmd: [
          "node",
          "--import=tsx",
          "apps/runner/src/index.ts",
          "--config",
          "/runner-assets/runner.toml",
        ],
        Labels: { "razbor.smoke": id },
        HostConfig: {
          Runtime: "kata",
          Init: true,
          NetworkMode: "bridge",
          Privileged: false,
          CapAdd: ["ALL"],
          SecurityOpt: [
            "seccomp=unconfined",
            "apparmor=unconfined",
            "writable-cgroups=true",
          ],
          Sysctls: {
            "net.ipv4.ip_forward": "1",
            "net.ipv6.conf.all.forwarding": "1",
            "net.ipv6.conf.default.forwarding": "1",
          },
          Memory: 6 * 1024 ** 3,
          MemorySwap: 6 * 1024 ** 3,
          NanoCpus: 4e9,
          PidsLimit: 2048,
          Tmpfs: { "/var/lib/docker": "rw,nosuid,size=4g" },
          Mounts: [
            {
              Type: "bind",
              Source: runnerFile,
              Target: "/runner-assets/runner.toml",
              ReadOnly: true,
            },
            {
              Type: "bind",
              Source: skills,
              Target: "/runner-assets/skills",
              ReadOnly: true,
            },
            {
              Type: "bind",
              Source: registrationRoot,
              Target: "/runner-registration",
              ReadOnly: true,
            },
            {
              Type: "bind",
              Source: path.join(root, "jobs"),
              Target: "/job-data",
            },
            {
              Type: "bind",
              Source:
                process.env.RAZBOR_RUNNER_RESOLV_CONF ??
                "/run/systemd/resolve/resolv.conf",
              Target: "/etc/resolv.conf",
              ReadOnly: true,
            },
          ],
        },
      });
      runner = docker.getContainer(runnerStartup.id);
      containers.push(runner);
      await network.connect({ Container: runner.id });
      console.log("Starting enrolled Kata runner VM");
      await runnerStartup.start({ abortSignal: AbortSignal.timeout(60000) });
      const runnerLogs = await runner.logs({
        follow: true,
        stdout: true,
        stderr: true,
      });
      docker.modem.demuxStream(runnerLogs, process.stdout, process.stderr);
      // A new VM has no image cache; keep cold image initialization separate
      // from the unchanged three-minute review deadline below.
      const runnerDeadline = Date.now() + 300000;
      let runnerReady = false;
      while (Date.now() < runnerDeadline) {
        assert.equal(
          (await runner.inspect()).State.Running,
          true,
          "Kata runner exited during startup",
        );
        const [registeredRunner] = await listRunners(state.database);
        runnerReady =
          registeredRunner?.id === provisionedRunner.id &&
          registeredRunner.status === "online";
        if (runnerReady) break;
        await delay(500);
      }
      assert.ok(
        runnerReady,
        "Kata runner did not finish daemon/image initialization",
      );
      const submit = await fetch(`${api}/review`, {
        method: "POST",
        headers: {
          ...authenticatedHeaders,
          "Content-Type": "application/json",
          Origin: api,
        },
        body: JSON.stringify({ repositoryId: registered.id, baseSha, headSha }),
        signal: AbortSignal.timeout(30000),
      });
      assert.equal(submit.status, 202, await submit.clone().text());
      const accepted = await submit.json();
      assert.ok(publicIdSchema("review").safeParse(accepted.id).success);
      console.log(
        "Polling one durable API review through the actual Kata runner and nested Docker agent",
      );
      let status;
      const deadline = Date.now() + 180000;
      do {
        assert.equal(
          (await runner.inspect()).State.Running,
          true,
          "Kata runner exited during review",
        );
        const response = await fetch(`${api}${accepted.statusUrl}`, {
          headers: authenticatedHeaders,
          signal: AbortSignal.timeout(10000),
        });
        assert.equal(response.status, 200);
        status = await response.json();
        if (["completed", "failed"].includes(status.status)) break;
        await delay(500);
      } while (Date.now() < deadline);
      assert.equal(status.status, "completed", JSON.stringify(status));
      assert.equal(status.repositoryId, registered.id);
      const review = status.review;
      const queue = await createQueue(state.database);
      try {
        const [queued] = await queue.findJobs<QueueJob>("reviews", {
          key: accepted.id,
        });
        assert.ok(queued);
        for (
          let i = 0;
          i < 40 &&
          (await queue.getJobById("reviews", queued.id))?.state !== "completed";
          i++
        )
          await delay(100);
        await queue.deleteJob("reviews", queued.id);
        const persisted = await (
          await fetch(`${api}${accepted.statusUrl}`, {
            headers: authenticatedHeaders,
            signal: AbortSignal.timeout(10000),
          })
        ).json();
        assert.deepEqual(persisted.review, review);
        // Re-delivery after queue retention still cannot execute another model call.
        const duplicateId = await queue.send("reviews", queued.data, {
          singletonKey: accepted.id,
        });
        assert.ok(duplicateId);
        for (let i = 0; i < 40; i++) {
          if (
            (await queue.getJobById("reviews", duplicateId))?.state ===
            "completed"
          )
            break;
          await delay(100);
        }
        assert.equal(
          (await queue.getJobById("reviews", duplicateId))?.state,
          "completed",
        );
      } finally {
        await queue.stop();
      }
      const internal = await state.administrator.query<{ id: string }>(
        "select id from repositories union all select id from reviews union all select id from review_attempts union all select id from index_workspaces union all select id from index_access_tokens",
      );
      const apiData = JSON.stringify({
        detail: status,
        list: await (
          await fetch(`${api}/reviews`, {
            headers: authenticatedHeaders,
            signal: AbortSignal.timeout(10000),
          })
        ).json(),
        repositories: await (
          await fetch(`${api}/repositories`, {
            headers: authenticatedHeaders,
            signal: AbortSignal.timeout(10000),
          })
        ).json(),
      });
      const html = await (
        await fetch(`${api}/jobs/${accepted.id}`, {
          headers: authenticatedHeaders,
          signal: AbortSignal.timeout(30000),
        })
      ).text();
      for (const row of internal.rows) {
        assert.ok(
          !apiData.includes(row.id) && !html.includes(row.id),
          "internal UUID leaked through API/UI",
        );
        assert.equal(
          (
            await fetch(`${api}/reviews/${row.id}`, {
              headers: authenticatedHeaders,
              signal: AbortSignal.timeout(10000),
            })
          ).status,
          400,
        );
      }
      if (modelFailure) throw modelFailure;
      assert.equal(calls, 9);
      assert.equal(review.findings[0]?.path, "math.ts");
      assert.deepEqual(
        await readdir(path.join(root, "index-data/reviews")),
        [],
      );
      assert.deepEqual(
        await readdir(path.join(root, "jobs", provisionedRunner.id)),
        [],
      );
      console.log(
        "PASS: TOML provisioning → enrollment → API → PostgreSQL outbox → pg-boss → enrolled Kata runner → authenticated Git pack → nested agent → relay → real MCP → persisted result; queue removal and duplicate delivery preserved completion.",
      );
    } catch (error) {
      if (dependencyPhase)
        console.error(`Smoke setup failed while ${dependencyPhase}.`);
      failed = true;
      failure = error;
    } finally {
      const cleanupFailures: string[] = [];

      /**
       * Settle only this fixture's resources, retrying Docker removal conflicts briefly
       * and reporting terminal cleanup failures without replacing the test's original error.
       */
      async function cleanup(
        label: string,
        operation: () => Promise<unknown>,
        tolerated = [404],
      ) {
        const deadline = Date.now() + 30000;
        while (true) {
          try {
            await operation();
            return;
          } catch (error) {
            const status = (error as { statusCode?: number }).statusCode;
            if (status !== undefined && tolerated.includes(status)) return;
            if (status === 409 && Date.now() < deadline) {
              await delay(500);
              continue;
            }
            cleanupFailures.push(
              `${label} (${status === undefined ? "request failed" : `Docker ${status}`})`,
            );
            return;
          }
        }
      }

      model.closeAllConnections();
      if (model.listening)
        await new Promise<void>((resolve) => model.close(() => resolve()));
      for (const container of containers.reverse()) {
        await cleanup(
          `stop fixture container ${container.id}`,
          () => container.stop({ t: 5 }),
          [304, 404],
        );
        await cleanup(`remove fixture container ${container.id}`, () =>
          container.remove({ force: true }),
        );
      }
      if (network)
        await cleanup("remove fixture network", () => network!.remove());
      if (volume)
        await cleanup("remove fixture dependency volume", () =>
          volume!.remove(),
        );
      if (webVolume)
        await cleanup("remove fixture web dependency volume", () =>
          webVolume!.remove(),
        );
      if (state) await cleanup("close fixture database", () => state!.close());
      await cleanup("remove fixture directory", () =>
        rm(root, { recursive: true, force: true }),
      );
      if (cleanupFailures.length) {
        cleanupFailure = `Fixture cleanup incomplete: ${cleanupFailures.join("; ")}`;
        if (failed) console.error(cleanupFailure);
      }
    }
    if (failed) throw failure;
    if (cleanupFailure) throw new Error(cleanupFailure);
  },
);
