import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";

import { z } from "zod";

import { reviewBudgetSchema, reviewResultSchema } from "@razbor/contracts";

const MAX_FILE_BYTES = 2_000_000;

const MAX_RUNS = 200;

const MAX_TOTAL_BYTES = 32_000_000;

const id = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[a-zA-Z0-9_.:-]+$/);

const sha = z.string().regex(/^[a-f0-9]{40}$/);

const digest = z.string().regex(/^[a-f0-9]{64}$/);

const count = z.number().int().nonnegative().safe();

const text = z.string().trim().min(1).max(8000);

const reference = z.string().url().max(2000);

const issueSchema = z
  .object({
    id,
    title: text,
    mechanism: text,
    evidence: z.array(reference).min(1).max(12),
    unsafeRemediation: text.optional(),
  })
  .strict();

const caseSchema = z
  .object({
    id,
    repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
    pullRequest: reference,
    baseSha: sha,
    headSha: sha,
    kind: z.enum(["defective", "corrected", "refuted_claim"]),
    expectedIssues: z.array(id).max(30),
    forbiddenClaims: z.array(id).max(30),
    notes: text,
  })
  .strict();

const datasetSchema = z
  .object({
    version: z.literal(1),
    name: id,
    scope: text,
    issues: z.array(issueSchema).min(1).max(100),
    cases: z.array(caseSchema).min(1).max(100),
  })
  .strict();

const configurationSchema = z
  .object({
    label: id,
    model: text,
    // Use immutable versions/digests; null reports missing historical provenance.
    promptVersion: text.nullable(),
    capabilitiesVersion: text.nullable(),
    maxTurns: z.number().int().min(1).max(512),
    // Absence preserves unknown historical settings; never infer defaults.
    reasoningEffort: z.enum(["low", "medium", "high"]).optional(),
    maxOutputTokens: z.number().int().min(1).max(32768).optional(),
    maxToolCalls: z.number().int().min(1).max(100000).optional(),
    maxTokens: z.number().int().min(1).max(100000000).optional(),
    maxCostUsd: z.number().finite().positive().optional(),
    compactionThresholdTokens: count.positive().optional(),
    // Validate with the runner policy, including duplicate provider/model identities,
    // then retain only supplied pricing instead of adding budget defaults to history.
    pricing: z
      .preprocess((pricing) => ({ pricing }), reviewBudgetSchema)
      .transform(({ pricing }) => pricing)
      .optional(),
  })
  .strict();

const telemetrySchema = z
  .object({
    durationMs: count.nullable(),
    inputTokens: count.nullable(),
    cachedInputTokens: count.nullable(),
    uncachedInputTokens: count.nullable().optional(),
    cacheWriteTokens: count.nullable().optional(),
    modelTurns: count.nullable().optional(),
    toolCalls: count.nullable().optional(),
    budgetTokens: count.nullable().optional(),
    outputTokens: count.nullable(),
    tokenUsageComplete: z.boolean().nullable(),
    costUsd: z.number().finite().nonnegative().nullable(),
    costBasis: z.enum(["provider", "estimate"]).nullable(),
    costEstimateComplete: z.boolean().nullable().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if ((value.costUsd === null) !== (value.costBasis === null))
      ctx.addIssue({
        code: "custom",
        message: "Cost needs both amount and basis",
      });
    const inputParts = [
      value.uncachedInputTokens,
      value.cachedInputTokens,
      value.cacheWriteTokens,
    ];
    const measuredParts = inputParts.filter(
      (part): part is number => typeof part === "number",
    );
    if (
      value.inputTokens !== null &&
      (measuredParts.reduce((total, part) => total + part, 0) >
        value.inputTokens ||
        (measuredParts.length === inputParts.length &&
          measuredParts.reduce((total, part) => total + part, 0) !==
            value.inputTokens))
    )
      ctx.addIssue({
        code: "custom",
        message: "Input token categories do not match total input",
      });
    if (
      value.tokenUsageComplete === true &&
      (value.inputTokens === null || value.outputTokens === null)
    )
      ctx.addIssue({
        code: "custom",
        message: "Complete usage needs input and output counts",
      });
  });

const executionSchema = z
  .object({
    runId: id,
    repository: z.string(),
    baseSha: sha,
    headSha: sha,
    configuration: configurationSchema,
    status: z.enum(["completed", "failed", "incomplete", "cancelled"]),
    result: reviewResultSchema.nullable(),
    telemetry: telemetrySchema,
    failureCategory: id.nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.status === "completed" &&
      (!value.result || value.failureCategory)
    )
      ctx.addIssue({
        code: "custom",
        message: "Completed execution requires a result and no failure",
      });
    if (value.result?.mode === "conversation")
      ctx.addIssue({
        code: "custom",
        message: "Conversation replies are not review evaluations",
      });
  });

const judgmentSchema = z
  .object({
    findingIndex: count,
    verdict: z.enum(["confirmed", "false_positive", "uncertain", "unassessed"]),
    issueIds: z.array(id).max(30),
    violatedControlIds: z.array(id).max(30),
    unsafeSuggestion: z.boolean().nullable(),
    evidence: z.string().max(8000),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.verdict !== "unassessed" && !value.evidence.trim())
      ctx.addIssue({
        code: "custom",
        message: "Adjudication requires source evidence",
      });
    if (value.issueIds.length && value.verdict !== "confirmed")
      ctx.addIssue({
        code: "custom",
        message: "Only confirmed findings match known issues",
      });
    if (value.violatedControlIds.length && value.verdict !== "false_positive")
      ctx.addIssue({
        code: "custom",
        message: "A violated negative control is a false positive",
      });
    if (value.verdict === "unassessed" && value.unsafeSuggestion !== null)
      ctx.addIssue({
        code: "custom",
        message: "Unassessed suggestions cannot have a safety verdict",
      });
  });

const runSchema = z
  .object({
    version: z.literal(1),
    datasetSha256: digest,
    caseId: id,
    assessor: z.enum(["human", "assistant"]).nullable(),
    // Binds manual judgments to the exact immutable result, including suggestions.
    resultSha256: digest,
    execution: executionSchema,
    judgments: z.array(judgmentSchema).max(20),
  })
  .strict();

type Dataset = z.infer<typeof datasetSchema>;

type EvaluationCase = z.infer<typeof caseSchema>;

type Run = z.infer<typeof runSchema>;

/** Hash the supplied bytes without exposing their contents in diagnostics. */
function hash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

/** Read one bounded regular JSON file without blocking on a named pipe before validation. */
async function readJson(filename: string) {
  const handle = await open(
    filename,
    constants.O_RDONLY | constants.O_NONBLOCK,
  );
  try {
    if (!(await handle.stat()).isFile())
      throw new Error("Input must be a regular file");
    const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        size,
        buffer.length - size,
        null,
      );
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > MAX_FILE_BYTES)
      throw new Error("Input exceeds the 2 MB file limit");
    const raw = buffer.subarray(0, size).toString("utf8");
    return { raw, value: JSON.parse(raw) as unknown };
  } finally {
    await handle.close();
  }
}

/** Reject duplicate semantic IDs rather than silently shrinking denominators. */
function unique(values: string[], label: string) {
  if (new Set(values).size !== values.length)
    throw new Error(`Duplicate ${label}`);
}

/** Validate labels and immutable revision pairs before producing a plan or score. */
function validateDataset(value: unknown) {
  const dataset = datasetSchema.parse(value);
  unique(
    dataset.issues.map((issue) => issue.id),
    "issue ID",
  );
  unique(
    dataset.cases.map((sample) => sample.id),
    "case ID",
  );
  const issues = new Set(dataset.issues.map((issue) => issue.id));
  for (const sample of dataset.cases) {
    unique(
      [...sample.expectedIssues, ...sample.forbiddenClaims],
      "case expectation",
    );
    if (sample.baseSha === sample.headSha)
      throw new Error("A case must contain a comparison");
    if (sample.kind === "defective" && !sample.expectedIssues.length)
      throw new Error("Defective cases need a verified expected issue");
    for (const key of [...sample.expectedIssues, ...sample.forbiddenClaims])
      if (!issues.has(key)) throw new Error("Case references an unknown issue");
  }
  return dataset;
}

/** Require the execution's actual repository and revision pair to match its case. */
function validateRevision(sample: EvaluationCase, execution: Run["execution"]) {
  if (
    execution.repository !== sample.repository ||
    execution.baseSha !== sample.baseSha ||
    execution.headSha !== sample.headSha
  )
    throw new Error(
      "Execution repository/base/head does not match its dataset case",
    );
}

/** Check manual judgments against original findings and this revision's expectations. */
function validateRun(run: Run, dataset: Dataset, datasetHash: string) {
  if (run.datasetSha256 !== datasetHash)
    throw new Error("Dataset digest mismatch");
  if (run.resultSha256 !== hash(JSON.stringify(run.execution.result)))
    throw new Error("Result changed after judgment preparation");
  const sample = dataset.cases.find((candidate) => candidate.id === run.caseId);
  if (!sample) throw new Error("Run references an unknown case");
  validateRevision(sample, run.execution);
  unique(
    run.judgments.map((judgment) => String(judgment.findingIndex)),
    "finding judgment",
  );
  const findings = run.execution.result?.findings ?? [];
  if (
    run.assessor === null &&
    run.judgments.some((judgment) => judgment.verdict !== "unassessed")
  )
    throw new Error("Adjudicated findings require assessor provenance");
  if (run.judgments.length !== findings.length)
    throw new Error(
      "Every finding needs exactly one judgment, including unassessed findings",
    );
  for (const judgment of run.judgments) {
    if (judgment.findingIndex >= findings.length)
      throw new Error("Judgment index is outside the result");
    unique(judgment.issueIds, "matched issue");
    unique(judgment.violatedControlIds, "negative control");
    if (judgment.issueIds.some((key) => !sample.expectedIssues.includes(key)))
      throw new Error("Matched issue is not expected on this revision");
    if (
      judgment.violatedControlIds.some(
        (key) => !sample.forbiddenClaims.includes(key),
      )
    )
      throw new Error("Negative control is not defined on this revision");
  }
  return sample;
}

/** Return null when a denominator has no observations rather than reporting zero. */
function ratio(numerator: number, denominator: number) {
  return denominator ? numerator / denominator : null;
}

/** Compute nearest-rank latency over measured attempts, including failed attempts. */
function percentile(values: number[], proportion: number) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * proportion) - 1)];
}

/** Score confirmed matches once per case/run, preserving unresolved judgments and failures. */
function scoreRun(sample: EvaluationCase, run: Run) {
  const completed = run.execution.status === "completed";
  const judgments = completed ? run.judgments : [];
  const matched = new Set(judgments.flatMap((judgment) => judgment.issueIds));
  const violated = new Set(
    judgments.flatMap((judgment) => judgment.violatedControlIds),
  );
  const unresolved = judgments.filter((judgment) =>
    ["uncertain", "unassessed"].includes(judgment.verdict),
  ).length;
  const unmatched = completed
    ? sample.expectedIssues.filter((key) => !matched.has(key))
    : [];
  return {
    caseId: sample.id,
    runId: run.execution.runId,
    status: run.execution.status,
    telemetry: run.execution.telemetry,
    expectedIssues: completed ? sample.expectedIssues.length : 0,
    detectedIssues: matched.size,
    missedIssueIds: unresolved ? [] : unmatched,
    unresolvedIssueIds: unresolved ? unmatched : [],
    failedIssueOpportunities: completed ? 0 : sample.expectedIssues.length,
    confirmedFindings: judgments.filter(
      (judgment) => judgment.verdict === "confirmed",
    ).length,
    falsePositives: judgments.filter(
      (judgment) => judgment.verdict === "false_positive",
    ).length,
    unresolvedFindings: unresolved,
    unsafeSuggestions: judgments.filter(
      (judgment) => judgment.unsafeSuggestion === true,
    ).length,
    safetyAssessed: judgments.filter(
      (judgment) => judgment.unsafeSuggestion !== null,
    ).length,
    safetyUnassessed: judgments.filter(
      (judgment) => judgment.unsafeSuggestion === null,
    ).length,
    violatedControlIds: [...violated],
    passedControlIds:
      completed && !unresolved
        ? sample.forbiddenClaims.filter((key) => !violated.has(key))
        : [],
    unresolvedControlIds:
      completed && unresolved
        ? sample.forbiddenClaims.filter((key) => !violated.has(key))
        : [],
  };
}

/** Aggregate one exact configuration without hiding missing measurements or repeats. */
function scoreGroup(dataset: Dataset, runs: Run[], datasetHash: string) {
  const details = runs.map((run) =>
    scoreRun(validateRun(run, dataset, datasetHash), run),
  );
  /** Sum a measured field across the scored attempts. */
  const sum = (select: (detail: (typeof details)[number]) => number) =>
    details.reduce((total, detail) => total + select(detail), 0);
  const telemetry = runs.map((run) => run.execution.telemetry);
  /** Keep measurement coverage alongside each observed sum. */
  const measurement = (
    key:
      | "inputTokens"
      | "cachedInputTokens"
      | "uncachedInputTokens"
      | "cacheWriteTokens"
      | "outputTokens"
      | "modelTurns"
      | "toolCalls"
      | "budgetTokens"
      | "costUsd",
  ) => {
    const values = telemetry
      .map((entry) => entry[key])
      .filter((value): value is number => typeof value === "number");
    return {
      total: values.length
        ? values.reduce((total, value) => total + value, 0)
        : null,
      measuredRuns: values.length,
      missingRuns: runs.length - values.length,
    };
  };
  const completed = details.filter(
    (detail) => detail.status === "completed",
  ).length;
  const failed = details.filter((detail) => detail.status === "failed").length;
  const expected = sum((detail) => detail.expectedIssues);
  const detected = sum((detail) => detail.detectedIssues);
  const uncertain = sum((detail) => detail.unresolvedIssueIds.length);
  const durations = telemetry
    .map((entry) => entry.durationMs)
    .filter((value) => value !== null);
  const seen = new Set(runs.map((run) => run.caseId));
  return {
    configuration: runs[0].execution.configuration,
    attempts: runs.length,
    completed,
    failed,
    incomplete: details.filter((detail) => detail.status === "incomplete")
      .length,
    cancelled: details.filter((detail) => detail.status === "cancelled").length,
    failureRate: ratio(failed, completed + failed),
    nonCompletionRate: ratio(runs.length - completed, runs.length),
    distinctCases: seen.size,
    missingCases: dataset.cases
      .filter((sample) => !seen.has(sample.id))
      .map((sample) => sample.id),
    knownIssueOpportunities: expected,
    detectedKnownIssues: detected,
    missedBugs: sum((detail) => detail.missedIssueIds.length),
    unresolvedKnownIssues: uncertain,
    failedIssueOpportunities: sum((detail) => detail.failedIssueOpportunities),
    knownIssueRecallLowerBound: ratio(detected, expected),
    knownIssueRecallUpperBound: ratio(detected + uncertain, expected),
    falsePositives: sum((detail) => detail.falsePositives),
    falsePositiveRate: ratio(
      sum((detail) => detail.falsePositives),
      sum((detail) => detail.falsePositives + detail.confirmedFindings),
    ),
    confirmedFindings: sum((detail) => detail.confirmedFindings),
    unresolvedFindings: sum((detail) => detail.unresolvedFindings),
    unsafeSuggestions: sum((detail) => detail.unsafeSuggestions),
    safetyAssessed: sum((detail) => detail.safetyAssessed),
    safetyUnassessed: sum((detail) => detail.safetyUnassessed),
    violatedNegativeControls: sum((detail) => detail.violatedControlIds.length),
    passedNegativeControls: sum((detail) => detail.passedControlIds.length),
    unresolvedNegativeControls: sum(
      (detail) => detail.unresolvedControlIds.length,
    ),
    assessorCounts: {
      human: runs.filter((run) => run.assessor === "human").length,
      assistant: runs.filter((run) => run.assessor === "assistant").length,
      unspecified: runs.filter((run) => run.assessor === null).length,
    },
    inputTokens: measurement("inputTokens"),
    cachedInputTokens: measurement("cachedInputTokens"),
    uncachedInputTokens: measurement("uncachedInputTokens"),
    cacheWriteTokens: measurement("cacheWriteTokens"),
    modelTurns: measurement("modelTurns"),
    toolCalls: measurement("toolCalls"),
    budgetTokens: measurement("budgetTokens"),
    outputTokens: measurement("outputTokens"),
    usageCompleteRuns: telemetry.filter(
      (entry) => entry.tokenUsageComplete === true,
    ).length,
    costUsd: measurement("costUsd"),
    costEstimateCompleteRuns: telemetry.filter(
      (entry) => entry.costEstimateComplete === true,
    ).length,
    costBasisCounts: {
      provider: telemetry.filter((entry) => entry.costBasis === "provider")
        .length,
      estimate: telemetry.filter((entry) => entry.costBasis === "estimate")
        .length,
    },
    latencyMs: {
      median: percentile(durations, 0.5),
      p95: percentile(durations, 0.95),
      measuredRuns: durations.length,
      missingRuns: runs.length - durations.length,
    },
    cases: details,
  };
}

/** Run an offline command; this CLI never starts a model, checks out code, or publishes. */
async function main() {
  const [command, filename, ...args] = process.argv.slice(2);
  if (!filename || !["validate", "plan", "record", "score"].includes(command))
    throw new Error(
      "Usage: evaluate <validate|plan> DATASET | record DATASET CASE EXECUTION_JSON | score DATASET RUN_JSON...",
    );
  const source = await readJson(filename);
  const dataset = validateDataset(source.value);
  const datasetHash = hash(source.raw);
  if (command === "validate" || command === "plan") {
    if (args.length) throw new Error("Unexpected arguments");
    console.log(
      JSON.stringify(
        command === "validate"
          ? {
              datasetSha256: datasetHash,
              cases: dataset.cases.length,
              issues: dataset.issues.length,
            }
          : {
              datasetSha256: datasetHash,
              cases: dataset.cases.map((sample) => ({
                caseId: sample.id,
                repository: sample.repository,
                baseSha: sample.baseSha,
                headSha: sample.headSha,
              })),
            },
        null,
        2,
      ),
    );
    return;
  }
  if (command === "record") {
    if (args.length !== 2)
      throw new Error("record requires CASE and EXECUTION_JSON");
    const sample = dataset.cases.find((candidate) => candidate.id === args[0]);
    if (!sample) throw new Error("Unknown case");
    const execution = executionSchema.parse((await readJson(args[1])).value);
    validateRevision(sample, execution);
    console.log(
      JSON.stringify(
        {
          version: 1,
          datasetSha256: datasetHash,
          caseId: sample.id,
          assessor: null,
          resultSha256: hash(JSON.stringify(execution.result)),
          execution,
          judgments: (execution.result?.findings ?? []).map(
            (_, findingIndex) => ({
              findingIndex,
              verdict: "unassessed",
              issueIds: [],
              violatedControlIds: [],
              unsafeSuggestion: null,
              evidence: "",
            }),
          ),
        },
        null,
        2,
      ),
    );
    return;
  }
  if (!args.length || args.length > MAX_RUNS)
    throw new Error("score requires 1..200 run files");
  const runs: Run[] = [];
  let loadedBytes = Buffer.byteLength(source.raw);
  // Sequential bounded reads keep peak input memory predictable on the workstation.
  for (const filename of args) {
    const input = await readJson(filename);
    loadedBytes += Buffer.byteLength(input.raw);
    if (loadedBytes > MAX_TOTAL_BYTES)
      throw new Error("Evaluation input exceeds the 32 MB combined limit");
    runs.push(runSchema.parse(input.value));
  }
  unique(
    runs.map((run) => run.execution.runId),
    "run ID",
  );
  const groups = new Map<string, Run[]>();
  for (const run of runs) {
    validateRun(run, dataset, datasetHash);
    const key = JSON.stringify(run.execution.configuration);
    groups.set(key, [...(groups.get(key) ?? []), run]);
  }
  console.log(
    JSON.stringify(
      {
        datasetSha256: datasetHash,
        scoring:
          "Source-adjudicated known-issue recall; not exhaustive correctness. Repeated runs are separate opportunities.",
        configurations: [...groups.values()].map((group) =>
          scoreGroup(dataset, group, datasetHash),
        ),
      },
      null,
      2,
    ),
  );
}

main().catch((error: unknown) => {
  // JSON/provider payloads may contain private source; emit categories, never input values.
  if (error instanceof z.ZodError)
    console.error(
      "Invalid evaluation input:",
      error.issues.map((issue) => issue.path.join(".")).join(", "),
    );
  else if (error instanceof SyntaxError) console.error("Invalid JSON input");
  else if (error instanceof Error && "code" in error)
    console.error("Cannot read evaluation input");
  else
    console.error(error instanceof Error ? error.message : "Evaluation failed");
  process.exitCode = 1;
});
