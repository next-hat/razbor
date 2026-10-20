import path from "node:path";
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";

import { reviewRepository } from "@razbor/harness";
import {
  agentJobSchema,
  modelProviderSchema,
  reasoningEffortSchema,
  reviewResultSchema,
} from "@razbor/contracts";

/** Print the job-file and result-file CLI contract used by the runner. */
function help() {
  console.log(
    "Usage: node --import=tsx apps/agent/src/index.ts --job JOB.json --output RESULT.json",
  );
}

const args = process.argv.slice(2);

if (args.includes("--help")) {
  help();
  process.exit(0);
}

/** Return the argument following a requested flag, or undefined when the flag is absent. */
const value = (flag: string) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};

const jobPath = value("--job"),
  output = value("--output");

if (!jobPath || !output) {
  help();
  process.exit(2);
}

let job;

try {
  job = agentJobSchema.parse(JSON.parse(await readFile(jobPath, "utf8")));
} catch (e) {
  console.error(`invalid job: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(2);
}

const abort = new AbortController();

/** Cancel the active harness review when the agent receives a termination signal. */
const stop = () => abort.abort(new Error("agent cancelled"));

process.once("SIGINT", stop);

process.once("SIGTERM", stop);

try {
  const result = reviewResultSchema.parse(
    await reviewRepository(job.repository, job.base, job.head, {
      baseUrl: process.env.LLM_BASE_URL ?? "http://127.0.0.1:8080/v1",
      model: process.env.LLM_MODEL ?? "gpt-oss-20b",
      apiKey: process.env.LLM_API_KEY ?? "local",
      provider: modelProviderSchema.parse(process.env.LLM_PROVIDER ?? "openai"),
      reasoningEffort: reasoningEffortSchema.parse(
        process.env.LLM_REASONING_EFFORT ?? "high",
      ),
      initialDiffMaxBytes: job.initialDiffMaxBytes,
      maxTurns: job.maxTurns,
      reviewBudget: job.reviewBudget,
      compactionThresholdTokens: job.compactionThresholdTokens,
      supportsTools: job.supportsTools,
      baselineSha: job.baseline,
      signal: abort.signal,
      reviewId: job.reviewId,
      capabilities: job.capabilities,
      verification: {
        exec: {
          // Trusted job environment only; never forward model/MCP tokens,
          // forge credentials, proxy credentials or runtime preload settings.
          env: {
            PATH: process.env.PATH,
            HOME: process.env.HOME,
            TMPDIR: process.env.TMPDIR,
            LANG: "C.UTF-8",
            CARGO_BUILD_JOBS: "2",
            RUST_TEST_THREADS: "2",
          },
        },
      },
      previousFindings: job.previousFindings,
      conversation: job.conversation,
      /**
       * Write schema-defined harness progress using the framing expected by the runner log
       * parser.
       */
      onProgress: (event) => {
        // Machine framing stays inside the sandbox; the runner renders plain text.
        process.stdout.write(`RAZBOR_PROGRESS ${JSON.stringify(event)}\n`);
      },
    }),
  );
  await mkdir(path.dirname(output), { recursive: true });
  const tmp = `${output}.${process.pid}.tmp`;
  await writeFile(
    tmp,
    JSON.stringify({ reviewId: job.reviewId, review: result }, null, 2) + "\n",
    "utf8",
  );
  await rename(tmp, output);
} catch {
  console.error("agent failed");
  process.exitCode = 1;
}
