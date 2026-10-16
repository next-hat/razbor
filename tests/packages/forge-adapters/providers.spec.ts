import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";

import {
  verifyRepository,
  ForgeReadError,
  type ForgeConnection,
} from "@razbor/forge-adapters";

test("bounded configured provider reads: paths, exact IDs, auth, errors and redirects", async () => {
  let mode = "ok";
  const seen: { url: string; auth: string | undefined }[] = [];
  const server = createServer((request, response) => {
    seen.push({
      url: request.url!,
      auth:
        request.headers.authorization ??
        (request.headers["private-token"] as string | undefined),
    });
    if (mode === "timeout") return;
    if (mode === "redirect") {
      response.writeHead(302, { Location: `${base}/credential-trap` });
      response.end();
      return;
    }
    if (mode === "auth") {
      response.writeHead(401);
      response.end();
      return;
    }
    if (mode === "not-found") {
      response.writeHead(404);
      response.end();
      return;
    }
    if (mode === "oversize") {
      response.end("x".repeat(1048577));
      return;
    }
    response.setHeader("content-type", "application/json");
    if (request.url!.includes("projects"))
      response.end(
        `{"id":90071992547409931234,"path_with_namespace":"team/sub/project","web_url":"${base}/web/team/sub/project","visibility":"internal","archived":false,"default_branch":"main"}`,
      );
    else
      response.end(
        `{"id":90071992547409931234,"full_name":"team/project","html_url":"${base}/web/team/project","private":true,"archived":false,"default_branch":"main"}`,
      );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    for (const type of ["github", "gitlab", "forgejo"] as const) {
      const c: ForgeConnection = {
        type,
        apiUrl: `${base}/installation/api`,
        webUrl: `${base}/web`,
        allowHttp: true,
        token: "deterministic-fixture-token",
        timeoutMs: 100,
      };
      const value = await verifyRepository(
        c,
        type === "gitlab" ? "team/sub/project" : "team/project",
      );
      assert.equal(value.externalRepositoryId, "90071992547409931234");
      assert.equal(
        seen.at(-1)!.url,
        type === "gitlab"
          ? "/installation/api/projects/team%2Fsub%2Fproject"
          : "/installation/api/repos/team/project",
      );
      assert.equal(
        seen.at(-1)!.auth,
        type === "gitlab"
          ? c.token
          : `${type === "github" ? "Bearer" : "token"} ${c.token}`,
      );
      for (const [next, reason] of [
        ["auth", "unauthorized"],
        ["not-found", "not-found"],
        ["timeout", "unavailable"],
        ["redirect", "unavailable"],
        ["oversize", "invalid-response"],
      ]) {
        mode = next;
        await assert.rejects(
          verifyRepository(c, "team/project"),
          (error: unknown) =>
            error instanceof ForgeReadError && error.reason === reason,
        );
      }
      mode = "ok";
      await assert.rejects(
        verifyRepository({ ...c, allowHttp: false }, "team/project"),
      );
    }
    assert.ok(!seen.some((r) => r.url === "/credential-trap"));
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
