import assert from "node:assert/strict";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { Ajv } from "ajv";
import pino, { type Logger } from "pino";

import type { ReviewProgress } from "@razbor/contracts";
import {
  execArguments,
  executeCommand,
  fetchUrl,
  fetchUrlArguments,
  searchWeb,
  VerificationTools,
  webSearchArguments,
} from "@razbor/harness/verification";

import { diffFixture } from "@tests/packages/harness/diff-fixture.js";
import { webFixture } from "@tests/packages/harness/verification-fixture.js";

/** Build an argument vector for executing an inline script with the current Node binary. */
const node = (script: string, ...args: string[]) => [
  process.execPath,
  "-e",
  script,
  ...args,
];

test("verification tools expose bounded schemas and reject invalid arguments", async () => {
  const tools = new VerificationTools("/unused");
  const definitions = await tools.definitions();
  assert.deepEqual(
    definitions.map((tool) => tool.type === "function" && tool.function.name),
    ["exec", "web_search", "fetch_url"],
  );
  const ajv = new Ajv();
  for (const [name, schema, valid, invalid] of [
    [
      "exec",
      execArguments,
      { argv: ["git", "diff"], timeoutMs: 120000 },
      [
        { argv: [] },
        { argv: "ls" },
        { argv: ["a\0b"] },
        { argv: ["ls"], cwd: "\0" },
        { argv: ["ls"], timeoutMs: 0 },
        { argv: ["ls"], maxOutputBytes: 1000001 },
        { argv: ["ls"], env: {} },
      ],
    ],
    [
      "web_search",
      webSearchArguments,
      { query: "official API", limit: 5 },
      [
        { query: "" },
        { query: "q", limit: 11 },
        { query: "q", provider: "arbitrary" },
      ],
    ],
    [
      "fetch_url",
      fetchUrlArguments,
      { url: "https://example.com/", maxOutputBytes: 1000 },
      [
        { url: "no url" },
        { url: "https://example.com", timeoutMs: 30001 },
        { url: "https://example.com", maxOutputBytes: 0 },
        { url: "https://example.com", headers: {} },
      ],
    ],
  ] as const) {
    assert.ok(schema.safeParse(valid).success);
    const definition = definitions.find(
      (tool) => tool.type === "function" && tool.function.name === name,
    )!;
    assert.equal(definition.type, "function");
    if (definition.type !== "function") throw new Error("Missing function");
    const validate = ajv.compile(definition.function.parameters!);
    assert.ok(validate(valid));
    assert.ok(definition.function.description);
    for (const input of invalid) {
      assert.equal(schema.safeParse(input).success, false);
      // Semantic URL validity is enforced by Zod and fetch_url itself.
      if (!("url" in input && input.url === "no url"))
        assert.equal(validate(input), false);
    }
  }
  assert.equal(execArguments.safeParse({ argv: [""] }).success, false);
  assert.equal(webSearchArguments.safeParse({ query: "   " }).success, false);
});

test("exec uses argv, captures streams/status, and forwards only explicit environment", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "razbor-exec-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const secret = process.env.RAZBOR_EXEC_TEST_SECRET;
  process.env.RAZBOR_EXEC_TEST_SECRET = "must-not-leak";
  t.after(() => {
    if (secret === undefined) delete process.env.RAZBOR_EXEC_TEST_SECRET;
    else process.env.RAZBOR_EXEC_TEST_SECRET = secret;
  });
  const literal = "$(echo injected); * $HOME";
  const result = await executeCommand(
    root,
    {
      argv: node(
        'process.stdout.write(JSON.stringify({args:process.argv.slice(1),env:process.env,cwd:process.cwd()})); process.stderr.write("diagnostic"); process.exitCode=7',
        literal,
      ),
    },
    { env: { RAZBOR_EXPLICIT_VALUE: "safe" } },
  );
  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 7);
  assert.equal(result.stderr, "diagnostic");
  assert.deepEqual(JSON.parse(result.stdout), {
    args: [literal],
    env: { RAZBOR_EXPLICIT_VALUE: "safe" },
    cwd: await realpath(root),
  });
  assert.equal(result.timedOut, false);
  assert.equal(result.truncated, false);
  assert.ok(result.durationMs >= 0);
  const clean = await executeCommand(root, {
    argv: node("process.stdout.write(JSON.stringify(process.env))"),
  });
  assert.equal(clean.ok, true);
  assert.deepEqual(JSON.parse(clean.stdout), {});
  await assert.rejects(
    executeCommand(root, { argv: ["/no-such-razbor-command"] }),
    /could not start/,
  );
});

test("exec confines cwd after resolving symlinks and accepts repository subdirectories", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "razbor-cwd-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = path.join(root, "repo");
  await mkdir(path.join(repo, "nested"), { recursive: true });
  await mkdir(path.join(root, "repo-other"));
  await symlink(root, path.join(repo, "escape"));
  await symlink(path.join(repo, "nested"), path.join(repo, "inside"));
  await writeFile(path.join(repo, "file"), "text");
  for (const cwd of ["..", "/", "escape", path.join(root, "repo-other")])
    await assert.rejects(
      executeCommand(repo, { argv: node(""), cwd }),
      /inside the review repository/,
    );
  await assert.rejects(
    executeCommand(repo, { argv: node(""), cwd: "file" }),
    /directory/,
  );
  for (const cwd of [
    undefined,
    "nested",
    "inside",
    path.join(repo, "nested"),
  ]) {
    const result = await executeCommand(repo, {
      argv: node("process.stdout.write(process.cwd())"),
      cwd,
    });
    assert.equal(
      result.stdout,
      await realpath(cwd ? path.resolve(repo, cwd) : repo),
    );
  }
});

test("exec explores source and recorded revisions with installed command-line utilities", async (t) => {
  const f = await diffFixture();
  t.after(() => f.close());
  const commands: [string[], RegExp][] = [
    [["git", "show", `${f.head}:source.ts`], /new implementation/],
    [["rg", "-n", "implementation", "."], /source.ts:1:new implementation/],
    [["grep", "-n", "implementation", "source.ts"], /1:new implementation/],
    [["cat", "source.ts"], /new implementation/],
    [["sed", "-n", "1p", "source.ts"], /new implementation/],
    [["awk", "NR == 1 { print }", "source.ts"], /new implementation/],
    [["head", "-n", "1", "source.ts"], /new implementation/],
    [["tail", "-n", "1", "source.ts"], /stable context/],
    [["find", ".", "-name", "related.ts"], /related.ts/],
  ];
  for (const [argv, expected] of commands)
    await t.test(argv[0], async (subtest) => {
      let result;
      try {
        result = await executeCommand(f.repository, { argv });
      } catch (error) {
        if (String(error).includes("ENOENT") && argv[0] !== "git") {
          subtest.skip(`optional installed utility unavailable: ${argv[0]}`);
          return;
        }
        throw error;
      }
      assert.equal(result.ok, true);
      assert.match(result.stdout, expected);
    });
});

test("exec ignores relative PATH entries and suppresses Git global config and transports", async (t) => {
  const f = await diffFixture();
  t.after(() => f.close());
  const shadow = path.join(f.repository, "cat");
  await writeFile(shadow, "#!/bin/sh\nprintf shadowed-command");
  await chmod(shadow, 0o755);
  for (const searchPath of [
    `.${path.delimiter}/usr/bin${path.delimiter}/bin`,
    ".",
  ]) {
    const result = await executeCommand(
      f.repository,
      { argv: ["cat", "source.ts"] },
      { env: { PATH: searchPath } },
    );
    assert.equal(result.ok, true);
    assert.match(result.stdout, /new implementation/);
    assert.doesNotMatch(result.stdout, /shadowed-command/);
  }
  await writeFile(
    path.join(f.repository, ".gitconfig"),
    "[alias]\n  private = !printf credential-from-user-config\n",
  );
  const global = await executeCommand(
    f.repository,
    { argv: ["git", "config", "--global", "--get", "alias.private"] },
    { env: { HOME: f.repository } },
  );
  assert.equal(global.exitCode, 1);
  assert.equal(global.stdout, "");
  const remote = await executeCommand(f.repository, {
    argv: ["git", "ls-remote", `file://${f.repository}`],
  });
  assert.equal(remote.ok, false);
  assert.match(remote.stderr, /transport 'file' not allowed/);
});

test("exec terminates background descendants when their command leader exits", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "razbor-exit-group-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const descendant =
    'process.stdout.write(String(process.pid)); process.send("ready"); setInterval(()=>{},1000)';
  const leader = `const child = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], {stdio:['ignore','inherit','inherit','ipc']}); child.once('message',()=>process.exit(0))`;
  const result = await executeCommand(
    root,
    { argv: node(leader) },
    { timeoutMs: 2000 },
  );
  assert.match(result.stdout, /^\d+$/);
  assert.equal(result.exitCode, 0);
  assert.equal(result.ok, true);
  assert.equal(result.timedOut, false);
});

test("exec bounds combined output without splitting UTF-8 and clamps trusted limits", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "razbor-output-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const script of [
    'process.stdout.write("💡".repeat(1000)); process.stderr.write("error".repeat(1000))',
    'process.stdout.write(Buffer.alloc(10000, 255)); process.stderr.write("error")',
  ]) {
    const result = await executeCommand(
      root,
      { argv: node(script), maxOutputBytes: 1000000 },
      { maxOutputBytes: 101 },
    );
    assert.equal(result.exitCode, 0);
    assert.equal(result.truncated, true);
    assert.ok(
      Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) <=
        101,
    );
    assert.equal(result.maxOutputBytes, 101);
    if (script.includes("💡"))
      assert.doesNotMatch(result.stdout + result.stderr, /�/);
  }
});

test("exec kills timed-out process groups and honors cancellation", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "razbor-timeout-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const marker = path.join(root, "escaped");
  const descendant = `setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'escaped'), 600)`;
  const script = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], {stdio:'inherit'}); setInterval(()=>{},1000)`;
  const result = await executeCommand(
    root,
    { argv: node(script), timeoutMs: 10000 },
    { timeoutMs: 200 },
  );
  assert.equal(result.timedOut, true);
  assert.equal(result.ok, false);
  assert.equal(result.signal, "SIGKILL");
  assert.equal(result.timeoutMs, 200);
  assert.ok(result.durationMs < 3000);
  await delay(700);
  await assert.rejects(readFile(marker), { code: "ENOENT" });
  const abort = new AbortController();
  const pending = executeCommand(
    root,
    { argv: node("setInterval(()=>{},1000)") },
    {},
    abort.signal,
  );
  const timer = setTimeout(() => abort.abort(), 100);
  try {
    const cancelled = await pending;
    assert.equal(cancelled.cancelled, true);
    assert.equal(cancelled.timedOut, false);
    assert.equal(cancelled.ok, false);
  } finally {
    clearTimeout(timer);
  }
  await assert.rejects(
    executeCommand(root, { argv: node("") }, {}, abort.signal),
  );
});

test("web search fails cleanly when absent, bounds injected results and hides provider errors", async () => {
  await assert.rejects(
    searchWeb({ query: "docs" }),
    /Web search is not configured/,
  );
  const result = await searchWeb(
    { query: " docs ", limit: 2 },
    {
      /** Check forwarded search options and return oversized results to exercise output limits. */
      async search(query, { limit, signal }) {
        assert.equal(query, "docs");
        assert.equal(limit, 2);
        assert.ok(signal instanceof AbortSignal);
        return Array.from({ length: 20 }, () => ({
          title: "💡".repeat(400),
          url: "https://example.com/docs",
          snippet: "s".repeat(4000),
        }));
      },
    },
  );
  assert.equal(result.results.length, 2);
  assert.ok(
    result.results.every(
      (r) =>
        Buffer.byteLength(r.title) <= 300 &&
        Buffer.byteLength(r.snippet) <= 2000,
    ),
  );
  await assert.rejects(
    searchWeb(
      { query: "q" },
      {
        /** Throw a sensitive provider error so the test can verify that public errors hide its details. */
        async search() {
          throw new Error("private-provider-key");
        },
      },
    ),
    (error: Error) => error.message === "Web search provider failed",
  );
  await assert.rejects(
    searchWeb(
      { query: "q" },
      {
        /** Return a non-HTTP result URL to exercise provider result validation. */
        async search() {
          return [{ title: "bad", url: "file:///etc/passwd", snippet: "" }];
        },
      },
    ),
    /HTTP/,
  );
  const abort = new AbortController();
  const pending = searchWeb(
    { query: "q" },
    {
      /** Keep the provider request pending so cancellation must settle the caller. */
      search: () => new Promise(() => {}),
    },
    abort.signal,
  );
  abort.abort();
  await assert.rejects(pending, /cancelled/);
});

test("fetch_url rejects non-HTTP, credentials, internal IPs and DNS results before connecting", async (t) => {
  const fixture = webFixture(t, []);
  for (const url of [
    "file:///etc/passwd",
    "ftp://example.com/file",
    "https://user:pass@example.com/",
    "http://localhost/",
    "http://localhost./",
    "http://foo.localhost/",
    "http://metadata.google.internal/",
    "http://metadata/",
    "http://host.home.arpa/",
    "http://127.0.0.1/",
    "http://127.1/",
    "http://2130706433/",
    "http://0x7f000001/",
    "http://0177.0.0.1/",
    "http://0.0.0.0/",
    "http://10.0.0.1/",
    "http://172.31.255.255/",
    "http://192.168.1.1/",
    "http://100.100.100.200/",
    "http://169.254.169.254/",
    "http://168.63.129.16/",
    "http://198.18.0.1/",
    "http://192.0.2.1/",
    "http://224.0.0.1/",
    "http://255.255.255.255/",
    "http://[::]/",
    "http://[::1]/",
    "http://[::ffff:127.0.0.1]/",
    "http://[fc00::1]/",
    "http://[fe80::1]/",
    "http://[ff02::1]/",
    "http://[2002:7f00:1::]/",
    "http://[64:ff9b::a00:1]/",
    "http://[2001:db8::1]/",
  ])
    await assert.rejects(fetchUrl({ url }));
  assert.equal(fixture.requests.length, 0);
  assert.equal(fixture.lookups.length, 0);
  for (const address of [
    "127.0.0.1",
    "10.1.1.1",
    "::1",
    "::ffff:169.254.169.254",
    "fd00::1",
  ]) {
    fixture.setAddresses(() => [
      { address: "93.184.215.14", family: 4 },
      { address, family: address.includes(":") ? 6 : 4 },
    ]);
    await assert.rejects(
      fetchUrl({ url: "https://public-looking.example.com/" }),
      /DNS.*public/,
    );
  }
  assert.equal(fixture.requests.length, 0);
});

test("fetch_url pins DNS at connection, preserves TLS hostname and extracts bounded public text", async (t) => {
  const fixture = webFixture(t, [
    { status: 302, headers: { location: "https://docs.example.com/api" } },
    {
      headers: { "content-type": "text/html; charset=utf-8" },
      chunks: [
        Buffer.from(
          "<style>hidden</style><h1>API &amp; docs</h1><script>secret()</script><p>Safe &#x1f4a1;</p>",
        ),
      ],
    },
    {},
  ]);
  const result = await fetchUrl({ url: "https://example.com/start" });
  assert.equal(result.ok, true);
  assert.equal(result.url, "https://docs.example.com/api");
  assert.equal(result.status, 200);
  assert.equal(result.redirects, 1);
  assert.equal(result.body, "API & docs Safe 💡");
  assert.equal(result.truncated, false);
  assert.deepEqual(fixture.lookups, ["example.com", "docs.example.com"]);
  for (const request of fixture.requests) {
    assert.equal(request.options.agent, false);
    assert.equal(request.options.family, 4);
    assert.ok(request.url.hostname.endsWith("example.com"));
    assert.equal(
      (request.options as { rejectUnauthorized?: boolean }).rejectUnauthorized,
      undefined,
    );
    await new Promise<void>((resolve, reject) =>
      request.options.lookup!(
        request.url.hostname,
        {},
        (error, address, family) => {
          if (error) return reject(error);
          assert.equal(address, "93.184.215.14");
          assert.equal(family, 4);
          resolve();
        },
      ),
    );
  }
  const ipv6 = await fetchUrl({ url: "http://[2606:4700:4700::1111]/" });
  assert.equal(ipv6.ok, true);
  assert.equal(fixture.requests.at(-1)!.options.family, 6);
  assert.ok(fixture.responses.every((response) => response.destroyed));
});

test("fetch_url times out DNS and cannot connect after a late public resolution", async (t) => {
  const fixture = webFixture(t, []);
  /** Provide an inert initializer until the pending DNS promise installs its resolver. */
  let release: (
    addresses: { address: string; family: number }[],
  ) => void = () => {};
  fixture.setAddresses(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  await assert.rejects(
    fetchUrl({ url: "https://example.com/", timeoutMs: 20 }),
    /timed out/,
  );
  release([{ address: "93.184.215.14", family: 4 }]);
  await delay(0);
  assert.equal(fixture.lookups.length, 1);
  assert.equal(fixture.requests.length, 0);
});

test("fetch_url revalidates redirects and same-host DNS, and bounds redirect counts", async (t) => {
  const fixture = webFixture(t, [
    { status: 302, headers: { location: "http://127.0.0.1/private" } },
    { status: 302, headers: { location: "/next" } },
    ...Array.from({ length: 6 }, () => ({
      status: 302,
      headers: { location: "/again" },
    })),
  ]);
  await assert.rejects(fetchUrl({ url: "https://example.com/" }), /public/);
  assert.equal(fixture.requests.length, 1);
  let resolutions = 0;
  fixture.setAddresses(() => [
    { address: ++resolutions === 1 ? "93.184.215.14" : "10.0.0.1", family: 4 },
  ]);
  await assert.rejects(
    fetchUrl({ url: "https://example.com/" }),
    /DNS.*public/,
  );
  assert.equal(fixture.requests.length, 2);
  fixture.setAddresses(() => [{ address: "93.184.215.14", family: 4 }]);
  await assert.rejects(
    fetchUrl({ url: "https://example.com/" }),
    /redirect limit/,
  );
  assert.equal(fixture.requests.length, 8);
});

test("fetch_url caps streamed responses and UTF-8 output, rejects binary and stops stalled bodies", async (t) => {
  const fixture = webFixture(t, [
    { chunks: [Buffer.from("💡".repeat(1000))] },
    { chunks: Array.from({ length: 20 }, () => Buffer.alloc(65536, 97)) },
    { headers: { "content-type": "image/png" } },
    { headers: { "content-type": "text/plain", "content-encoding": "gzip" } },
    { chunks: [Buffer.from([0, 1, 2])] },
    { chunks: [Buffer.from([255, 255])] },
    { status: 404, chunks: [Buffer.from("not found")] },
    { stall: true },
  ]);
  const clipped = await fetchUrl({
    url: "https://example.com/",
    maxOutputBytes: 101,
  });
  assert.equal(clipped.body, "💡".repeat(25));
  assert.equal(clipped.truncated, true);
  const large = await fetchUrl({
    url: "https://example.com/",
    maxOutputBytes: 100000,
  });
  assert.equal(large.body.length, 100000);
  assert.equal(large.truncated, true);
  assert.ok(
    fixture.chunksRead[1] < 20,
    "oversize bodies must stop before consuming the full response",
  );
  for (const pattern of [/content type/, /Compressed/, /binary/, /valid text/])
    await assert.rejects(fetchUrl({ url: "https://example.com/" }), pattern);
  const missing = await fetchUrl({ url: "https://example.com/" });
  assert.equal(missing.status, 404);
  assert.equal(missing.ok, false);
  assert.equal(missing.body, "not found");
  await assert.rejects(
    fetchUrl({ url: "https://example.com/", timeoutMs: 20 }),
    /timed out/,
  );
  assert.ok(fixture.responses.every((response) => response.destroyed));
});

test("the autonomous review loop explores with exec and retains outcomes without logging content", async (t) => {
  const globals = globalThis as typeof globalThis & { razborLogger?: Logger };
  const previousLogger = globals.razborLogger;
  globals.razborLogger = pino({ enabled: false });
  t.after(() => {
    globals.razborLogger = previousLogger;
  });
  const { reviewRepository } = await import("@razbor/harness");
  const f = await diffFixture();
  t.after(() => f.close());
  webFixture(t, [{ chunks: [Buffer.from("external-evidence-content")] }]);
  const events: ReviewProgress[] = [];
  const calls = [
    {
      name: "exec",
      arguments: JSON.stringify({
        argv: node(
          'process.stdout.write("verification-content"); process.exitCode=3',
        ),
      }),
    },
    {
      name: "web_search",
      arguments: JSON.stringify({ query: "unconfigured-query" }),
    },
    {
      name: "fetch_url",
      arguments: JSON.stringify({ url: "https://example.com/docs" }),
    },
    {
      name: "exec",
      arguments: JSON.stringify({ argv: ["cat", "source.ts"] }),
    },
  ];
  let turn = 0;
  let modelFailure: unknown;
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: unknown, init: RequestInit) => {
      try {
        const body = JSON.parse(String(init.body));
        assert.ok(
          calls.every((call) =>
            body.tools.some(
              (tool: { name: string }) => tool.name === call.name,
            ),
          ),
        );
        if (turn && turn <= calls.length) {
          const input = body.input;
          const offset = [...input]
            .reverse()
            .findIndex(
              (message: { type?: string }) =>
                message.type === "function_call_output",
            );
          const index = input.length - offset - 1;
          const observation = input[index].output;
          assert.match(
            observation,
            /^Observation reference tool-\d+ \(.*not a verification verdict\):\n/,
          );
          const output = JSON.parse(
            observation.slice(observation.indexOf("\n") + 1),
          );
          assert.deepEqual(
            {
              name: input[index - 1].name,
              arguments: input[index - 1].arguments,
            },
            calls[turn - 1],
          );
          assert.equal(input[index].call_id, `verification-${turn - 1}`);
          if (turn <= 3) assert.ok(output.durationMs >= 0);
          if (turn === 1) {
            assert.equal(output.exitCode, 3);
            assert.equal(output.stdout, "verification-content");
            assert.equal(output.ok, false);
          }
          if (turn === 2) {
            assert.match(output.error.message, /not configured/);
            assert.equal(output.ok, false);
          }
          if (turn === 3) {
            assert.equal(output.body, "external-evidence-content");
            assert.equal(output.ok, true);
          }
          if (turn === 4) {
            assert.equal(output.ok, true);
            assert.match(output.stdout, /new implementation/);
          }
        }
        const call = calls[turn];
        turn++;
        return new Response(
          JSON.stringify({
            id: "fixture",
            object: "response",
            created_at: 0,
            status: "completed",
            model: "fixture",
            output: [
              call
                ? {
                    id: `verification-function-${turn - 1}`,
                    type: "function_call",
                    status: "completed",
                    call_id: `verification-${turn - 1}`,
                    ...call,
                  }
                : {
                    id: "verification-message",
                    type: "message",
                    status: "completed",
                    role: "assistant",
                    content: [
                      {
                        type: "output_text",
                        text: JSON.stringify({
                          summary:
                            "No actionable findings. The verification command exited with status 3; web search was unavailable.",
                          findings: [],
                        }),
                        annotations: [],
                      },
                    ],
                  },
            ],
          }),
          { headers: { "content-type": "application/json" } },
        );
      } catch (error) {
        modelFailure = error;
        throw error;
      }
    },
  );
  await reviewRepository(f.repository, f.base, f.head, {
    baseUrl: "http://fixture.invalid/v1",
    apiKey: "fixture",
    model: "fixture",
    reasoningEffort: "low",
    reviewId: "fixture",
    /** Collect review progress events for tool-failure and diagnostic-safety assertions. */
    onProgress: (event) => events.push(event),
  }).catch((error) => {
    throw modelFailure ?? error;
  });
  assert.equal(turn, 5);
  assert.ok(
    events.some(
      (event) =>
        event.level === "warn" && event.message.includes("exec failed"),
    ),
  );
  assert.ok(
    events.some(
      (event) =>
        event.level === "warn" && event.message.includes("web_search failed"),
    ),
  );
  assert.doesNotMatch(
    JSON.stringify(events),
    /verification-content|external-evidence-content|unconfigured-query|example.com/,
  );
});
