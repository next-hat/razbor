import Link from "next/link.js";

import type { ReviewJobView } from "@razbor/contracts";
import type { PullRequestView } from "@razbor/database";

import { Badge } from "@web/components/ui/badge.js";
import { actionLabels, decisionLabels } from "@web/lib/merge-triage.js";

/** Present the most actionable current state and never reuse a historical score as today's verdict. */
export function MergeBadge({
  merge,
  status,
}: Readonly<{
  merge: PullRequestView["merge"];
  status?: ReviewJobView["status"];
}>) {
  if (!merge)
    return (
      <span className="text-xs text-muted-foreground">
        {status === "failed"
          ? "Review failed"
          : status === "completed"
            ? "No merge decision"
            : status === "queued" || status === "running"
              ? "Review in progress"
              : "Awaiting review"}
      </span>
    );
  const decision = merge.decision.status;
  const action = merge.action;
  if (
    merge.decision.reasons.some(
      (reason) => reason.code === "unresolved_provider_merge",
    )
  )
    return (
      <>
        {decision === "human_review_required" && (
          <Badge variant="warning">{decisionLabels[decision]}</Badge>
        )}
        <Badge variant="warning">Merge reconciliation required</Badge>
      </>
    );
  const attention =
    action === "refused" ||
    action === "uncertain" ||
    decision === "blocked" ||
    decision === "human_review_required";
  return (
    <Badge
      variant={
        attention ? "warning" : decision === "merged" ? "success" : "secondary"
      }
    >
      {action && decision !== "stale" && decision !== "human_review_required"
        ? actionLabels[action]
        : decisionLabels[decision]}
    </Badge>
  );
}

/** Display a PR decision or a clearly labelled historical review decision with the corresponding evidence. */
export function MergeDecisionPanel({
  merge,
  review,
}: Readonly<{ merge?: PullRequestView["merge"]; review?: ReviewJobView }>) {
  const assessment = review?.review?.mergeAssessment;
  const value = review?.mergeDecision
    ? {
        decision: review.mergeDecision,
        action: review.mergeAction,
        confidence: assessment?.confidence,
        minimumConfidence: review.minimumConfidence,
        riskLevel: assessment?.riskLevel,
      }
    : merge;
  const score = value?.confidence ?? assessment?.confidence;
  const threshold = value?.minimumConfidence ?? review?.minimumConfidence;
  const risk = value?.riskLevel ?? assessment?.riskLevel;
  const messages = [
    ...new Set([
      ...(value?.decision.reasons.map((reason) => reason.message) ?? []),
      ...(assessment?.reasons ?? []),
      ...(assessment?.criticalAreas ?? []),
      ...(assessment?.verificationGaps ?? []),
    ]),
  ];
  return (
    <section
      className="console-card flex flex-col items-start gap-3"
      aria-label={
        review ? "Recorded review decision" : "Current merge decision"
      }
    >
      <h2 className="font-semibold">
        {review ? "Recorded review decision" : "Current merge decision"}
      </h2>
      {value ? (
        <MergeBadge merge={value} />
      ) : (
        <p className="text-sm text-muted-foreground">
          No merge decision has been recorded.
        </p>
      )}
      {(risk || score !== undefined) && (
        <p className="text-sm">
          {score !== undefined && (
            <span className="tabular-nums">
              Confidence {score}/100
              {threshold !== undefined && ` · threshold ${threshold}`}
            </span>
          )}
          {risk && (
            <span>
              {score !== undefined && " · "}
              {risk} risk
            </span>
          )}
        </p>
      )}
      {messages.length > 0 && (
        <ul className="list-disc space-y-1 break-words pl-4 text-sm">
          {messages.map((message) => (
            <li key={message}>{message}</li>
          ))}
        </ul>
      )}
      {value?.decision.reviewers.length ? (
        <p className="break-words text-sm">
          Suggested reviewers ·{" "}
          {value.decision.reviewers.map((name) => `@${name}`).join(", ")}
        </p>
      ) : null}
      {review && (
        <p className="text-xs text-muted-foreground">
          Review of{" "}
          <code>{review.headSha?.slice(0, 12) ?? "unknown revision"}</code>
          {review.mergePolicyVersion !== undefined &&
            ` · Policy v${review.mergePolicyVersion}`}
        </p>
      )}
      {review?.pullRequestId && (
        <Link
          className="text-sm underline underline-offset-4"
          href={`/pull-requests/${review.pullRequestId}`}
        >
          View current pull request decision
        </Link>
      )}
      {score !== undefined && (
        <p className="text-xs text-muted-foreground">
          Confidence is the model’s uncalibrated assessment of merge readiness.
        </p>
      )}
    </section>
  );
}
