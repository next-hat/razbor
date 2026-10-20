# Evaluate audited revisions

Compare recorded reviews against a curated set of audited revisions. The commands
run offline: they validate inputs and score recorded judgments without calling a
model, fetching code, submitting jobs, or publishing comments.

Console evaluation marks are separate. A “potential false positive” mark flags a
finding for investigation; it does not establish that the finding is wrong.

Use Node 24 and the repository's installed dependencies:

```sh
pnpm evaluate validate tests/evaluation/audited-revisions.json
pnpm evaluate plan tests/evaluation/audited-revisions.json
```

The dataset contains 16 base/head comparisons and 17 issue definitions, covering
defects, corrections, and claims refuted by source inspection. Each issue links
to the relevant source or corrective commit. Use these examples to calibrate a
reviewer; they are not a held-out accuracy benchmark or a complete defect list.
Corrected cases forbid specific earlier claims and may still contain other bugs.

## Capture an execution

`plan` emits case IDs, repository names, base/head SHAs, and the dataset digest.
Use these revisions with the isolated harness or runner. Keep the model, prompt
and capability versions, and budgets consistent across comparisons. Record each
intentional change as a different configuration.

Run sequentially with a deadline and the runner resource limits. Save logs and
results outside the checkout, in a directory you own.

Give the model only the pinned source/diff and review configuration. Exclude
expected issues, assessment notes, previous reviews, later fixes, and answers from
other configurations. Use an isolated checkout at each head: command tools must
not read a newer working tree or the developer's live checkout.

Save an execution record for every attempt, including failures. Preserve the
original harness `ReviewResult` in `result`; use `null` for missing measurements
or results. Keep credentials and raw provider error bodies out of the record.
Copy repository and revision values from `plan`; the example below uses case `c01`.

```json
{
  "runId": "candidate-c01-1",
  "repository": "next-hat/proxy",
  "baseSha": "3b8660a620b88a0a2844252c273d1afa7c15e17f",
  "headSha": "76b60e5f3b2f8877dbcad4bee4433e03a6f5285f",
  "configuration": {
    "label": "candidate",
    "model": "configured-model-id",
    "promptVersion": null,
    "capabilitiesVersion": null,
    "maxTurns": 24,
    "reasoningEffort": "high",
    "maxOutputTokens": 4096,
    "maxToolCalls": 2048,
    "maxTokens": 1000000,
    "compactionThresholdTokens": 80000
  },
  "status": "completed",
  "result": { "summary": "Original result text", "findings": [] },
  "telemetry": {
    "durationMs": null,
    "inputTokens": null,
    "cachedInputTokens": null,
    "uncachedInputTokens": null,
    "cacheWriteTokens": null,
    "modelTurns": null,
    "toolCalls": null,
    "budgetTokens": null,
    "outputTokens": null,
    "tokenUsageComplete": null,
    "costUsd": null,
    "costBasis": null,
    "costEstimateComplete": null
  },
  "failureCategory": null
}
```

Record actual immutable prompt/capability versions or digests when available.
Null provenance is permitted for historical imports but limits comparability.
Record `reasoningEffort` (`low`, `medium`, or `high`) and `maxOutputTokens`
(an integer from 1 through 32768, matching the runner limit) for new executions.
Record the tool-call/token limits and compaction threshold too. If monetary
limits apply, record `maxCostUsd` and the explicit `pricing` object from the review
configuration, including its exact model and all four token prices. These fields
are optional for compatibility with existing records: absent values mean unknown
and are never replaced with current defaults. Every recorded setting participates
in configuration grouping, so different known settings remain separate. Keep
externally recovered settings in their provenance unless the original execution
metadata supports adding them.
Allowed statuses are `completed`, `failed`, `incomplete`, and `cancelled`.
Completed requires a result and no failure category; a timeout or malformed result
must remain unsuccessful. A failure category is a short safe identifier such as
`model_output_invalid`, not the provider payload. Token counts are final cumulative
attempt totals, including any retries. Cost must include its basis (`provider` or
`estimate`); no price or token-to-money conversion is assumed.

For new autonomous-agent runs, copy measured `modelTurns`, `toolCalls`,
`uncachedInputTokens`, and `cacheWriteTokens` from the final attempt metrics,
including unsuccessful attempts. Model turns include compaction calls. Input
counts are normalized totals: cached reads, uncached input and separately billed
cache writes are disjoint parts of `inputTokens`; never add them to that total
again. Unknown cache categories remain absent or null, rather than inferred zero.
`budgetTokens` is a conservative budget charge and may exceed measured usage
when a request failed or omitted telemetry. Preserve that distinction.

Map `estimatedCostUsd` to `costUsd` with `costBasis: "estimate"`, and preserve
`costEstimateComplete`. An incomplete estimate can contain conservative reserved
cost for an unmeasured request; it is not an observed provider charge. Do not use
incomplete token or cost records to claim savings.

Prepare a record using the actual execution metadata:

```sh
pnpm evaluate record tests/evaluation/audited-revisions.json c01 \
  /tmp/razbor-evaluation/c01-execution.json > /tmp/razbor-evaluation/c01-run.json
```

The command verifies repository/base/head and binds the record to the dataset bytes
and original result with SHA-256 digests. It adds one unassessed judgment per
finding. It does not infer a semantic match from a title, filename, reviewer name,
severity, or string similarity. Preserve the original record and source evidence;
the hashes detect accidental changes, not malicious rewriting of both inputs.

## Adjudicate and score

Check every finding against the exact source, preferably without seeing the
configuration label. Set `assessor` to `human` or `assistant` according to who
checked it. Leave unresolved claims uncertain. The scoring command uses these
judgments; it cannot verify the reasoning behind them.

Each judgment has these fields:

- `findingIndex`: zero-based position in the unchanged result.
- `verdict`: `confirmed`, `false_positive`, `uncertain`, or `unassessed`.
- `issueIds`: known issue IDs detected by a confirmed finding, only from that
  case's `expectedIssues`. An additional valid finding can be confirmed with an
  empty list; it is not a false positive just because the dataset omitted it.
- `violatedControlIds`: case-specific `forbiddenClaims` repeated by a false
  positive. Other source-refuted findings can have an empty list.
- `unsafeSuggestion`: `true` for a source-supported harmful recommendation,
  `false` after checking its safety, or `null` while unassessed. Detection and
  remediation quality are independent: a confirmed finding can suggest an unsafe
  change. Mark the overbroad END_STREAM-only fix unsafe if it cancels protection for
  unfinished upload/callback work.
- `evidence`: a concise rationale with source revision/locations or reproduction
  evidence. Required for every assessed verdict.

Do not replace findings or rewrite suggestions to make judgments fit. Re-import
another output as a distinct run. Empty completed outputs need no per-finding
judgments; they miss that revision's expected issues and pass only its listed
negative controls. Failed or incomplete runs are never scored as clean outputs.

```sh
pnpm evaluate score tests/evaluation/audited-revisions.json \
  /tmp/razbor-evaluation/*-run.json > /tmp/razbor-evaluation/scores.json
```

Each exact configuration is reported separately, with case coverage and run-level
details. Duplicate run IDs, stale dataset/result digests, revision mismatches,
duplicate judgments, and invalid issue/control references are rejected. Inputs
are limited to 2 MB each, 32 MB combined and 200 run files per invocation; reading
is sequential.

Read the scores with their denominators:

- Known-issue recall counts each expected issue once per completed case/run.
  Multiple matching findings cannot inflate recall. Uncertain/unassessed findings
  leave unmatched issues unresolved, producing lower/upper recall bounds; they do
  not silently become misses or false positives.
- Missed bugs, confirmed findings, false positives and unsafe suggestions are
  separate counts. False-positive rate uses confirmed plus false-positive findings;
  unresolved findings and suggestion-safety coverage remain visible.
- Failure rate is failed / (completed + failed), matching the console definition.
  Non-completion rate includes failed, incomplete and cancelled / all attempts.
  Expected issues in unsuccessful runs are reported as failed opportunities, not
  model misses. Missing cases are listed separately.
- Token counts, model turns, tool calls and cost totals include unsuccessful
  attempts and report measured/missing run counts. Historical records without the
  new fields remain unknown. Cached and cache-write input are already included in
  total input. Incomplete observed token usage is a lower bound; conservative
  budget charges are reported separately. Cost basis counts distinguish estimates
  from provider charges, and complete-estimate coverage remains visible. Each case
  also retains its original attempt telemetry.
- Median and p95 duration use measured attempts, including unsuccessful ones;
  missing durations stay unknown. Repeated runs are separate observations, and
  case details show them so an unbalanced repetition count cannot be hidden.

Compare configurations on the same cases with the same repetition counts. Read
individual findings and unsafe suggestions alongside the totals. Use separate
held-out revisions before making broader claims about review quality.

A deterministic tool-dispatch fixture checks control flow and contract validation;
it does not measure finding recall or false positives for a real model. To compare
the staged baseline and autonomous implementation, run both immutable harness
versions on the same defective and corrected/refuted cases, using the same model,
reasoning effort, resource limits, pricing and repetition counts. Record every
attempt, adjudicate against pinned source, and score both configurations. If the
required runner image, Kata runtime, model access or revision sources are missing,
report those checks as unavailable and leave savings and quality changes unclaimed.
