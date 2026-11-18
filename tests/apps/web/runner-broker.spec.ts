import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import {
  getReview,
  reviewLogs,
  consumeRunnerEnrollment,
  createRunner,
  listRepositories,
  submitReview,
} from "@razbor/database";
import {
  codebaseMemoryUnavailableCode,
  codebaseMemoryUnavailableMessage,
} from "@razbor/contracts";
import { applyRegistry, registrySchema } from "@razbor/database/registry";
import { createQueue } from "@razbor/queue";
import { runnerConfigSchema } from "@razbor/runner/config";
import { RunnerBroker } from "@razbor/web/runner-broker";
import {
  deployedCodebaseMemory,
  withRegistrationIndexDefault,
} from "@razbor/web/indexer";

import { databaseFixture } from "@tests/packages/database/fixture.js";

/** Create a fresh JSON request for each bounded broker operation. */
function jsonRequest(input: unknown) {
  return new Request("http://fixture.invalid/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
}

test(
  "broker binds source, private index and review memory to each live attempt",
  { timeout: 90000 },
  async (t) => {
    const config = registrySchema.parse({
      registry: { key: "broker-test" },
      forges: {},
      repositories: Object.fromEntries(
        ["plain", "indexed"].map((name) => [
          name,
          {
            codebaseMemoryEnabled: name === "indexed",
            git: {
              branch: "main",
              upstream: "refs/remotes/origin/main",
              remotes: {
                origin: "https://fixture.invalid/team/repository.git",
              },
            },
            indexing: { owner: "fixture" },
          },
        ]),
      ),
    });
    const management = randomBytes(32).toString("hex");
    const grants = new Map<string, string>();
    const indexCalls: string[] = [];
    const headSha = "b".repeat(40);
    const baseSha = "a".repeat(40);
    const workspaceId = "idx_0123456789ABCDEF";
    let advertised: boolean | "legacy" | "offline" = false;
    let rejectIndex = false;
    // Exercise the production broker against the management protocol, substituting
    // only the source service. Git pack contents are covered by the source fixture.
    const server = createServer(async (request, response) => {
      const auth = request.headers.authorization;
      if (
        request.method === "GET" &&
        request.url === "/health" &&
        auth === `Bearer ${management}`
      ) {
        if (advertised === "offline") response.writeHead(503).end();
        else
          response.end(
            JSON.stringify({
              status: "ready",
              ...(advertised === "legacy"
                ? {}
                : { capabilities: { codebaseMemory: advertised } }),
            }),
          );
        return;
      }
      if (
        request.url === "/reviews" &&
        request.method === "POST" &&
        auth === `Bearer ${management}`
      ) {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(chunk);
        const binding = JSON.parse(Buffer.concat(chunks).toString());
        if (rejectIndex) {
          response
            .writeHead(503, {
              "x-razbor-error-code": codebaseMemoryUnavailableCode,
            })
            .end();
          return;
        }
        const token = randomBytes(32).toString("hex");
        grants.set(binding.attemptId, token);
        response.end(
          JSON.stringify({
            attemptId: binding.attemptId,
            id: "tok_0123456789ABCDEF",
            workspaceId,
            token,
            headSha: binding.headSha,
            expiresAt: Date.now() + 60000,
            ...(binding.repositoryId === indexedRepository
              ? {
                  project: workspaceId,
                  indexHeadSha: baseSha,
                  indexBranch: "main",
                }
              : {}),
          }),
        );
        return;
      }
      const [, , attemptId, operation] = (request.url ?? "").split("/");
      if (
        request.method === "DELETE" &&
        auth === `Bearer ${management}` &&
        grants.delete(attemptId)
      ) {
        response.writeHead(204).end();
        return;
      }
      const token = grants.get(attemptId);
      if (operation === "source" && token && auth === `Bearer ${token}`) {
        response
          .writeHead(200, { "x-razbor-object-format": "sha1" })
          .end(`fixture pack ${attemptId}`);
        return;
      }
      if (
        request.url === "/mcp" &&
        auth &&
        [...grants.values()].some((grant) => auth === `Bearer ${grant}`)
      ) {
        indexCalls.push(auth);
        response.end("fixture index result");
        return;
      }
      response.writeHead(403).end();
    });
    const previousEndpoint = process.env.RAZBOR_INDEX_ENDPOINT;
    const previousToken = process.env.RAZBOR_INDEX_MANAGEMENT_TOKEN;
    const fixture = await databaseFixture();
    const db = fixture.database;
    t.after(async () => {
      if (previousEndpoint === undefined)
        delete process.env.RAZBOR_INDEX_ENDPOINT;
      else process.env.RAZBOR_INDEX_ENDPOINT = previousEndpoint;
      if (previousToken === undefined)
        delete process.env.RAZBOR_INDEX_MANAGEMENT_TOKEN;
      else process.env.RAZBOR_INDEX_MANAGEMENT_TOKEN = previousToken;
      server.closeAllConnections();
      server.close();
      await fixture.close();
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    assert.ok(address && typeof address === "object");
    process.env.RAZBOR_INDEX_ENDPOINT = `http://127.0.0.1:${address.port}`;
    process.env.RAZBOR_INDEX_MANAGEMENT_TOKEN = management;
    assert.equal(await deployedCodebaseMemory(), false);
    assert.deepEqual(await withRegistrationIndexDefault({}), {
      codebaseMemoryEnabled: false,
    });
    assert.deepEqual(
      await withRegistrationIndexDefault({ codebaseMemoryEnabled: true }),
      { codebaseMemoryEnabled: true },
    );
    advertised = true;
    assert.deepEqual(await withRegistrationIndexDefault({}), {
      codebaseMemoryEnabled: true,
    });
    assert.deepEqual(
      await withRegistrationIndexDefault({ codebaseMemoryEnabled: false }),
      { codebaseMemoryEnabled: false },
    );
    for (const state of ["legacy", "offline"] as const) {
      advertised = state;
      assert.equal(await deployedCodebaseMemory(), null);
      assert.deepEqual(await withRegistrationIndexDefault({}), {
        codebaseMemoryEnabled: true,
      });
    }
    await applyRegistry(db, config);
    const repositories = await listRepositories(db);
    const indexedRepository = repositories.find(
      (repo) => repo.configKey === "indexed",
    )!.id;
    const { runner, enrollmentToken } = await createRunner(db, {
      name: "broker fixture",
      repositoryIds: repositories.map((repo) => repo.id),
    });
    const sessionId = randomUUID();
    await consumeRunnerEnrollment(db, {
      token: enrollmentToken,
      sessionId,
      capacity: 2,
      runtimeReady: true,
      protocolVersion: 1,
      timeoutMs: 60000,
      fallbackModel: true,
    });
    for (const repository of repositories)
      await submitReview(db, { repositoryId: repository.id, baseSha, headSha });
    const queue = await createQueue(db);
    const broker = new RunnerBroker(db, queue);
    try {
      const assignments: NonNullable<
        Awaited<ReturnType<RunnerBroker["claim"]>>["assignment"]
      >[] = [];
      const model = runnerConfigSchema.parse({}).model;
      const deadline = Date.now() + 20000;
      while (assignments.length < 2 && Date.now() < deadline) {
        const { assignment } = await broker.claim(
          runner.id,
          sessionId,
          assignments.map((item) => item.attemptId),
          model,
        );
        if (assignment) assignments.push(assignment);
        else await delay(100);
      }
      assert.equal(
        assignments.length,
        2,
        "both revision-bound workspaces must be assigned",
      );
      const plain = assignments.find(
        (item) => item.job.repositoryId !== indexedRepository,
      )!;
      const indexed = assignments.find(
        (item) => item.job.repositoryId === indexedRepository,
      )!;
      assert.ok(plain && indexed);
      assert.equal(plain.index, undefined);
      assert.deepEqual(indexed.index, {
        project: workspaceId,
        indexHeadSha: baseSha,
        indexBranch: "main",
        queryMs: 15000,
      });
      assert.equal(plain.job.baseSha, baseSha);
      assert.equal(plain.job.headSha, headSha);
      // Flipping both live repository settings must leave the issued grants intact.
      config.repositories.plain.codebaseMemoryEnabled = true;
      config.repositories.indexed.codebaseMemoryEnabled = false;
      await applyRegistry(db, config);
      for (const item of assignments) {
        assert.ok(item.memory);
        assert.doesNotMatch(
          JSON.stringify(item),
          new RegExp(grants.get(item.attemptId)!),
        );
        const source = await broker.source(
          item.attemptId,
          item.capabilityToken,
          jsonRequest({}),
        );
        assert.equal(source.headers.get("x-razbor-object-format"), "sha1");
        assert.equal(await source.text(), `fixture pack ${item.attemptId}`);
        const memory = await broker.memory(
          item.attemptId,
          item.capabilityToken,
          jsonRequest({ operation: "list" }),
        );
        assert.equal(memory.status, 200);
        assert.deepEqual((await memory.json()).documents, []);
      }
      await assert.rejects(
        broker.source(
          plain.attemptId,
          indexed.capabilityToken,
          jsonRequest({}),
        ),
        { status: 401 },
      );
      await assert.rejects(
        broker.mcp(plain.attemptId, plain.capabilityToken, jsonRequest({})),
        { status: 403 },
      );
      assert.deepEqual(indexCalls, []);
      const indexResponse = await broker.mcp(
        indexed.attemptId,
        indexed.capabilityToken,
        jsonRequest({}),
      );
      assert.equal(await indexResponse.text(), "fixture index result");
      assert.deepEqual(indexCalls, [`Bearer ${grants.get(indexed.attemptId)}`]);
      for (const item of assignments) {
        await broker.result(item.attemptId, runner.id, sessionId, {
          terminal: true,
        });
        await assert.rejects(
          broker.source(item.attemptId, item.capabilityToken, jsonRequest({})),
          { status: 401 },
        );
      }
      rejectIndex = true;
      // Fail the durable terminal write while allowing pg-boss to settle its claim.
      await fixture.administrator.query(
        "ALTER TABLE reviews ADD CONSTRAINT fixture_terminal_write CHECK (status <> 'failed') NOT VALID",
      );
      const review = await submitReview(db, {
        repositoryId: plain.job.repositoryId,
        baseSha,
        headSha,
      });
      const retryBy = Date.now() + 15000;
      let [job] = await queue.findJobs(queue.name, { key: review.id });
      while (
        job?.state !== "retry" &&
        job?.state !== "cancelled" &&
        Date.now() < retryBy
      ) {
        await delay(50);
        [job] = await queue.findJobs(queue.name, { key: review.id });
      }
      assert.equal(job?.state, "retry");
      assert.equal((await getReview(db, review.id))?.status, "running");
      await fixture.administrator.query(
        "ALTER TABLE reviews DROP CONSTRAINT fixture_terminal_write",
      );
      await fixture.administrator.query(
        "UPDATE review_attempts SET lease_until = now() WHERE review_id = (SELECT id FROM reviews WHERE public_id=$1)",
        [review.id],
      );
      const end = Date.now() + 15000;
      while (
        (await getReview(db, review.id))?.status !== "failed" &&
        Date.now() < end
      )
        await delay(100);
      assert.equal((await getReview(db, review.id))?.status, "failed");
      const log = await reviewLogs(db, review.id, 0);
      assert.ok(
        log.logs.some(
          (line) => line.event.message === codebaseMemoryUnavailableMessage,
        ),
      );
    } finally {
      await broker.close();
    }
    assert.equal(grants.size, 0, "all prepared source grants must be revoked");
  },
);
