import { z } from "zod";

import { MAX_REVIEW_FINDINGS, type ReviewResult } from "@razbor/contracts";

import type { ChangedFile, PreparedDiff } from "@harness/src/tools/diff.js";
import { git, MAX_GIT_OUTPUT_BYTES } from "@harness/src/git.js";

const referenceSchema = z.array(z.string().min(1)).max(100);

export const checkpointSchema = z.object({
  summary: z.string().min(1).max(6000),
  risks: z
    .array(
      z.object({
        id: z.string().trim().min(1).max(100),
        path: z.string().min(1),
        contract: z.string().trim().min(1).max(2000),
        trigger: z.string().trim().min(1).max(2000),
        before: z.string().trim().min(1).max(2000),
        after: z.string().trim().min(1).max(2000),
        evidenceIds: referenceSchema,
      }),
    )
    .max(100),
  candidates: z
    .array(
      z
        .object({
          path: z.string().min(1),
          lineStart: z.number().int().positive(),
          lineEnd: z.number().int().positive(),
          scenario: z.string().min(1).max(2000),
          status: z.enum(["supported", "dismissed", "unresolved"]),
          evidenceIds: referenceSchema,
        })
        .refine((candidate) => candidate.lineEnd >= candidate.lineStart),
    )
    .max(100),
  unresolved: z.array(z.string().min(1).max(2000)).max(100),
  limitations: z.array(z.string().min(1).max(2000)).max(100),
});

export type ReviewCheckpoint = z.infer<typeof checkpointSchema>;

export type ReviewStage = "investigate" | "verify" | "challenge";

const focusRules = [
  {
    name: "Authorization and isolation",
    pattern: /auth|session|token|tenant|permission|identity|organi[sz]ation/i,
    guide:
      "Trace untrusted identity and resource IDs through ownership checks and downstream consumers. Challenge cross-user and cross-organization access, stale sessions and defaults.",
  },
  {
    name: "Protocols and connections",
    pattern: /proxy|http|stream|socket|tls|connection|relay|protocol/i,
    guide:
      "Trace framing, encoding and connection state across reads, writes and shutdown. Challenge partial input, backpressure, reuse and cleanup; separate per-request and per-connection authorization.",
  },
  {
    name: "Concurrency and lifecycle",
    pattern: /queue|worker|runner|retry|task|job|lock|cache|shutdown|pool/i,
    guide:
      "Follow ownership, cancellation and cleanup across actual asynchronous boundaries. Challenge retries, races and sequences of at least three events, including shutdown and partial failure.",
  },
  {
    name: "Persistence and boundaries",
    pattern: /migrat|database|schema|storage|serializ|contract|config|\.sql$/i,
    guide:
      "Trace writes, reads, migrations and serialization together. Challenge legacy records, null versus omitted values, partial updates, constraints and compatibility at consuming boundaries.",
  },
  {
    name: "API and agent contracts",
    pattern: /api|agent|provider|model|tool|mcp|prompt|llm/i,
    guide:
      "Verify request, response and tool contracts across consumers, including trusted instruction boundaries. Check provider completion and error states, cancellation and budgets; inspect tool outcomes rather than assuming successful execution.",
  },
  {
    name: "Frontend behavior",
    pattern: /component|page\.|route\.|form|\.tsx$|\.vue$|\.svelte$/i,
    guide:
      "Trace user input through validation and server authorization. Challenge loading/error states, stale state, navigation and escaped output in the actual consuming context.",
  },
  {
    name: "Rust ownership and errors",
    pattern: /\.rs$/i,
    guide:
      "Trace ownership, lifetimes, drop paths, error propagation and task cancellation. Verify API/version assumptions locally. Do not claim Cargo checks passed when the executable or dependencies are unavailable.",
  },
];

export type FocusPath = {
  path: string;
  revision: "head" | "baseline";
  ranges: { start: number; end: number }[];
  reasons: string[];
};

export type ReviewFocus = {
  sections: { name: string; guide: string }[];
  paths: FocusPath[];
};

/** Excludes generated assets and passive prose from mandatory deep source inspection. */
function executableChange(file: ChangedFile) {
  return (
    file.content === "text" &&
    !/(?:^|\/)(?:dist|build|generated|node_modules)(?:\/|$)|(?:^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock)|\.(?:md|mdx|txt|rst|csv|svg|snap|map|min\.js|lock)$/i.test(
      file.path,
    )
  );
}

/** Identifies conventional test-only paths without excluding maintained vendor source. */
function testOnlyPath(path: string) {
  return /(?:^|\/)(?:tests?|__tests__|__mocks__)(?:\/|$)|(?:^|\/)test_[^/]+$|[._-](?:test|spec)\.[^/]+$/i.test(
    path,
  );
}

/**
 * Chooses up to three minimum deep-inspection targets, production before test-only
 * paths, then path-risk signals and changed-line size. This is not exhaustive risk coverage.
 */
export async function selectReviewFocus(
  repository: string,
  prepared: PreparedDiff,
  signal?: AbortSignal,
): Promise<ReviewFocus> {
  const sections = focusRules.filter((rule) =>
    prepared.files.some((file) => rule.pattern.test(file.path)),
  );
  const candidates = prepared.files
    .filter(executableChange)
    .map((file) => ({
      file,
      testOnly: testOnlyPath(file.path),
      reasons: focusRules
        .filter((rule) => rule.pattern.test(file.path))
        .map(({ name }) => name),
    }))
    .sort(
      (a, b) =>
        Number(a.testOnly) - Number(b.testOnly) ||
        b.reasons.length - a.reasons.length ||
        (b.file.added ?? 0) +
          (b.file.deleted ?? 0) -
          ((a.file.added ?? 0) + (a.file.deleted ?? 0)) ||
        a.file.path.localeCompare(b.file.path),
    );
  const paths = await Promise.all(
    candidates.slice(0, 3).map(async ({ file, reasons }) => {
      const revision =
        !file.headPath || (file.added === 0 && (file.deleted ?? 0) > 0)
          ? ("baseline" as const)
          : ("head" as const);
      const patch = await git(
        repository,
        [
          "diff",
          "--no-ext-diff",
          "--no-textconv",
          "--unified=0",
          "--find-renames",
          prepared.baselineSha,
          prepared.headSha,
          "--",
          ...new Set(
            [file.baselinePath, file.headPath].filter(
              (path): path is string => path !== null,
            ),
          ),
        ],
        signal,
        false,
        MAX_GIT_OUTPUT_BYTES,
      );
      const ranges = [
        ...patch.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm),
      ].map((match) => {
        const start = Number(match[revision === "head" ? 3 : 1]);
        const count = Number(match[revision === "head" ? 4 : 2] ?? 1);
        return {
          start: Math.max(1, start),
          end: Math.max(1, start + count - 1),
        };
      });
      return {
        path:
          revision === "baseline"
            ? (file.baselinePath ?? file.path)
            : file.path,
        revision,
        ranges,
        reasons: reasons.length
          ? reasons
          : ["Largest remaining executable change"],
      };
    }),
  );
  return {
    sections: sections.map(({ name, guide }) => ({ name, guide })),
    paths,
  };
}

type SourceEvidence = {
  id: string;
  kind: "source";
  stage: ReviewStage | "final";
  path: string;
  revision: "head" | "baseline";
  start: number;
  end: number;
};

type CommandEvidence = {
  id: string;
  kind: "command";
  stage: ReviewStage | "final";
  exitCode: number;
  passed: boolean;
};

export type ReviewEvidence = SourceEvidence | CommandEvidence;

export class ReviewEvidenceLedger {
  readonly records: ReviewEvidence[] = [];

  /** Captures only successful pinned source pages and completed command results. */
  record(
    id: string,
    name: string,
    result: string,
    stage: ReviewEvidence["stage"],
  ) {
    let value;
    try {
      value = JSON.parse(result);
    } catch {
      return;
    }
    if (
      name === "read_file" &&
      value.state === "available" &&
      (value.revision === "head" || value.revision === "baseline") &&
      typeof value.path === "string" &&
      Number.isSafeInteger(value.startLine) &&
      Number.isSafeInteger(value.endLine) &&
      value.endLine >= value.startLine
    ) {
      this.records.push({
        id,
        kind: "source",
        stage,
        path: value.path,
        revision: value.revision,
        start: value.startLine,
        end: value.endLine,
      });
    } else if (
      name === "exec" &&
      Number.isInteger(value.exitCode) &&
      !value.cancelled &&
      !value.timedOut
    ) {
      this.records.push({
        id,
        kind: "command",
        stage,
        exitCode: value.exitCode,
        passed: value.ok === true && value.exitCode === 0,
      });
    }
  }

  /** Checks coverage of a line range using only cited, successfully delivered pages. */
  covers(
    path: string,
    revision: "head" | "baseline",
    start: number,
    end: number,
    ids?: string[],
  ) {
    const pages = this.records
      .filter(
        (record): record is SourceEvidence =>
          record.kind === "source" &&
          record.path === path &&
          record.revision === revision &&
          (!ids || ids.includes(record.id)),
      )
      .sort((a, b) => a.start - b.start);
    let next = start;
    for (const page of pages) {
      if (page.start > next) break;
      if (page.end >= next) next = page.end + 1;
      if (next > end) return true;
    }
    return false;
  }

  /**
   * Validates observable inspection obligations and citations. It cannot establish
   * that the model's reasoning or a free-text invariant is semantically correct.
   */
  gaps(
    checkpoint: ReviewCheckpoint,
    focus: ReviewFocus,
    prepared: PreparedDiff,
    stage: ReviewStage,
    previous?: ReviewCheckpoint,
    freshEvidenceStart = 0,
  ) {
    const gaps: string[] = [];
    if (prepared.coverage().unreadFiles)
      gaps.push(
        "Reviewable diff pages remain unread; finish read_diff pagination.",
      );
    for (const item of [...checkpoint.risks, ...checkpoint.candidates]) {
      if (
        !item.evidenceIds.length ||
        item.evidenceIds.some(
          (id) => !this.records.some((record) => record.id === id),
        )
      )
        gaps.push(`Missing or unknown evidence citations for ${item.path}.`);
    }
    const riskIds = new Set<string>();
    for (const risk of checkpoint.risks) {
      if (riskIds.has(risk.id))
        gaps.push(`Duplicate risk identity: ${risk.id}.`);
      riskIds.add(risk.id);
      if (
        !this.records.some(
          (record) =>
            record.kind === "source" &&
            record.path === risk.path &&
            risk.evidenceIds.includes(record.id),
        )
      )
        gaps.push(`Risk scenario lacks inspected source at ${risk.path}.`);
    }
    for (const target of focus.paths) {
      const risks = checkpoint.risks.filter(
        (risk) => risk.path === target.path,
      );
      const ids = risks.flatMap((risk) => risk.evidenceIds);
      const inspected = target.ranges.length
        ? target.ranges.some((range) =>
            this.records.some(
              (record) =>
                record.kind === "source" &&
                record.path === target.path &&
                record.revision === target.revision &&
                ids.includes(record.id) &&
                record.start <= range.end &&
                record.end >= range.start,
            ),
          )
        : this.records.some(
            (record) =>
              record.kind === "source" &&
              record.path === target.path &&
              record.revision === target.revision &&
              ids.includes(record.id),
          );
      if (!risks.length || !inspected)
        gaps.push(
          `Inspect a changed source hunk at ${target.revision}:${target.path} and cite it in a concrete failure scenario.`,
        );
    }
    for (const candidate of checkpoint.candidates) {
      if (
        !this.covers(
          candidate.path,
          "head",
          candidate.lineStart,
          candidate.lineEnd,
          candidate.evidenceIds,
        )
      )
        gaps.push(
          `Candidate source range not inspected: ${candidate.path}:${candidate.lineStart}-${candidate.lineEnd}.`,
        );
      if (stage !== "investigate" && candidate.status === "unresolved")
        gaps.push(
          `Candidate remains unresolved: ${candidate.path}:${candidate.lineStart}.`,
        );
    }
    // A new unrelated concern cannot substitute for challenging a retained contract.
    const challengeSubjects =
      previous && (previous.risks.length || previous.candidates.length)
        ? [
            ...checkpoint.risks.filter((risk) =>
              previous.risks.some((prior) => prior.id === risk.id),
            ),
            ...checkpoint.candidates.filter((candidate) =>
              previous.candidates.some(
                (prior) =>
                  prior.path === candidate.path &&
                  candidate.lineStart <= prior.lineStart &&
                  candidate.lineEnd >= prior.lineEnd,
              ),
            ),
          ]
        : [...checkpoint.risks, ...checkpoint.candidates];
    if (
      stage === "challenge" &&
      (focus.paths.length || checkpoint.candidates.length) &&
      !challengeSubjects.some((item) =>
        item.evidenceIds.some((id) =>
          this.records
            .slice(freshEvidenceStart)
            .some((record) => record.id === id && record.stage === "challenge"),
        ),
      )
    )
      gaps.push(
        "Challenge requires a new successful source page or completed command tied to a retained risk contract or candidate.",
      );
    if (stage !== "investigate") {
      for (const risk of previous?.risks ?? []) {
        const retained = checkpoint.risks.find((item) => item.id === risk.id);
        if (!retained)
          gaps.push(
            `Prior risk contract was not reassessed: ${risk.id} at ${risk.path}.`,
          );
        else if (
          retained.path !== risk.path ||
          retained.contract !== risk.contract ||
          retained.trigger !== risk.trigger
        )
          gaps.push(
            `Preserve the path, contract and trigger for risk ${risk.id}; revise before/after conclusions or add a new risk instead.`,
          );
      }
      for (const candidate of previous?.candidates ?? []) {
        if (
          candidate.status !== "dismissed" &&
          !checkpoint.candidates.some(
            (item) =>
              item.path === candidate.path &&
              item.lineStart <= candidate.lineStart &&
              item.lineEnd >= candidate.lineEnd,
          )
        )
          gaps.push(
            `Prior candidate was not reassessed: ${candidate.path}:${candidate.lineStart}.`,
          );
      }
      gaps.push(...checkpoint.unresolved);
    }
    return [...new Set(gaps)];
  }

  /** Requires every published finding and replacement to match verified, challenged source. */
  finalGaps(review: ReviewResult, challenge: ReviewCheckpoint) {
    const gaps: string[] = [];
    const supported = challenge.candidates.filter(
      (candidate) => candidate.status === "supported",
    );
    for (const finding of review.findings) {
      if (
        !this.covers(finding.path, "head", finding.lineStart, finding.lineEnd)
      )
        gaps.push(
          `Finding range lacks source evidence: ${finding.path}:${finding.lineStart}-${finding.lineEnd}.`,
        );
      if (
        finding.replacement &&
        !this.covers(
          finding.path,
          "head",
          finding.replacement.startLine,
          finding.replacement.endLine,
        )
      )
        gaps.push(
          `Replacement range lacks source evidence: ${finding.path}:${finding.replacement.startLine}-${finding.replacement.endLine}.`,
        );
      if (
        !supported.some(
          (candidate) =>
            candidate.path === finding.path &&
            candidate.lineStart <= finding.lineStart &&
            candidate.lineEnd >= finding.lineEnd,
        )
      )
        gaps.push(
          `Finding was not supported in the challenge checkpoint: ${finding.path}:${finding.lineStart}.`,
        );
    }
    if (
      supported.length <= MAX_REVIEW_FINDINGS ||
      review.findings.length < MAX_REVIEW_FINDINGS
    ) {
      for (const candidate of this.omittedSupportedCandidates(
        review,
        challenge,
      ))
        gaps.push(
          `Supported candidate omitted from final findings: ${candidate.path}:${candidate.lineStart}.`,
        );
    }
    return gaps;
  }

  /** Identifies supported candidates omitted by the final result for explicit limit disclosure. */
  omittedSupportedCandidates(
    review: ReviewResult,
    challenge: ReviewCheckpoint,
  ) {
    return challenge.candidates.filter(
      (candidate) =>
        candidate.status === "supported" &&
        !review.findings.some(
          (finding) =>
            finding.path === candidate.path &&
            finding.lineStart >= candidate.lineStart &&
            finding.lineEnd <= candidate.lineEnd,
        ),
    );
  }
}
