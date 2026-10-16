"use client";

import { useId, useRef, useState } from "react";
import { CircleCheck } from "lucide-react";

import {
  reviewEvaluationSchema,
  type ReviewEvaluation,
  type ReviewEvaluationUpdate,
  type ReviewResult as Result,
} from "@razbor/contracts";
import { fileLanguage, findingCounts } from "@razbor/contracts/presentation";

import { ReviewCode } from "@web/components/review-code.js";
import { ReviewMarkdown } from "@web/components/review-markdown.js";
import { Status } from "@web/components/status.js";
import { Alert, AlertDescription } from "@web/components/ui/alert.js";
import { Badge } from "@web/components/ui/badge.js";
import { Checkbox } from "@web/components/ui/checkbox.js";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@web/components/ui/field.js";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@web/components/ui/select.js";

const assessmentOptions = [
  { value: "unassessed", label: "Unassessed" },
  { value: "confirmed", label: "Confirmed finding" },
  { value: "potential_false_positive", label: "Potential false positive" },
];

/**
 * Presents a review summary and expandable findings, retaining duplicate findings with
 * distinct rendering keys. PR detail pages can open explanations by default;
 * completed review pages can save manual assessments without
 * depending on the execution stream or whether a finding has been fixed.
 */
export function ReviewResult({
  review,
  reviewId,
  evaluation,
  defaultExpanded = false,
}: Readonly<{
  review: Result;
  reviewId?: string;
  evaluation?: ReviewEvaluation;
  defaultExpanded?: boolean;
}>) {
  const controlId = useId();
  const pending = useRef(false);
  const [savedEvaluation, setSavedEvaluation] = useState<ReviewEvaluation>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const editable = Boolean(reviewId && review.mode !== "conversation");
  const noFindings =
    review.mode !== "conversation" && review.findings.length === 0;
  const currentEvaluation = savedEvaluation ??
    evaluation ?? { included: false, findings: {} };

  /** Serializes optional feedback writes and adopts the durable response after each save. */
  async function saveEvaluation(update: ReviewEvaluationUpdate) {
    if (!editable || !reviewId || pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const response = await fetch(`/api/reviews/${reviewId}/evaluation`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(update),
      });
      const result: unknown = await response.json();
      if (!response.ok) {
        const reason =
          result &&
          typeof result === "object" &&
          "error" in result &&
          typeof result.error === "string"
            ? result.error
            : "Unable to save evaluation. Try again.";
        throw new Error(reason);
      }
      const saved = reviewEvaluationSchema.safeParse(result);
      if (!saved.success)
        throw new Error("Evaluation response unavailable. Reload this page.");
      setSavedEvaluation(saved.data);
      setMessage("Evaluation saved.");
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "Unable to save evaluation. Try again.",
      );
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  const occurrences = new Map<string, number>();
  const findings = review.findings.map((finding, index) => {
    const content = JSON.stringify([
      finding.path,
      finding.lineStart,
      finding.lineEnd,
      finding.title,
      finding.severity,
    ]);
    const occurrence = occurrences.get(content) ?? 0;
    occurrences.set(content, occurrence + 1);
    return {
      finding,
      index,
      key: `${content}:${occurrence}`,
      location: `${finding.path}:${finding.lineStart}${finding.lineEnd === finding.lineStart ? "" : `-${finding.lineEnd}`}`,
      assessment: currentEvaluation.findings[String(index)],
    };
  });
  const breakdown = findingCounts(review.findings)
    .filter((c) => c.count)
    .map((c) => `${c.count} ${c.severity}`)
    .join(" · ");
  return (
    <section
      className="flex min-w-0 flex-col gap-4 rounded-lg border bg-card p-4 text-card-foreground"
      aria-labelledby="review-result-heading"
    >
      <div className="flex min-w-0 flex-col gap-4">
        {noFindings ? (
          <div className="flex items-center gap-3 rounded-lg bg-success/10 p-3">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-success/10 text-success">
              <CircleCheck aria-hidden="true" className="size-5" />
            </span>
            <div className="min-w-0">
              <h2
                id="review-result-heading"
                className="text-base font-semibold text-success"
              >
                No actionable findings
              </h2>
              <p className="mt-1 text-xs text-muted-foreground">
                Nothing to triage from this automated review.
              </p>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <h2 id="review-result-heading" className="text-base font-semibold">
              {review.mode === "conversation"
                ? "razbor reply"
                : "razbor review"}
            </h2>
            {review.mode !== "conversation" && (
              <p className="text-sm font-medium">
                {review.findings.length} finding
                {review.findings.length === 1 ? "" : "s"}
                {breakdown ? ` · ${breakdown}` : ""}
              </p>
            )}
          </div>
        )}
        <ReviewMarkdown>{review.summary}</ReviewMarkdown>
      </div>
      {editable && (
        <section
          className="flex flex-col gap-3"
          aria-label="Review evaluation"
          aria-busy={busy}
        >
          <FieldGroup>
            <Field orientation="horizontal" data-disabled={busy}>
              <Checkbox
                id={`${controlId}-included`}
                checked={currentEvaluation.included}
                disabled={busy}
                onCheckedChange={(included) =>
                  void saveEvaluation({ included })
                }
              />
              <FieldContent>
                <FieldLabel htmlFor={`${controlId}-included`}>
                  Include this review in evaluation
                </FieldLabel>
                <FieldDescription>
                  {noFindings
                    ? "Include this reviewed revision in your evaluation data."
                    : "Applies to this reviewed revision. Unfixed findings remain unassessed until marked."}
                </FieldDescription>
              </FieldContent>
            </Field>
          </FieldGroup>
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          {(busy || message) && (
            <output
              className="text-sm text-muted-foreground"
              aria-live="polite"
            >
              {busy ? "Saving evaluation…" : message}
            </output>
          )}
        </section>
      )}
      {review.findings.length > 0 && (
        <>
          <ul className="flex flex-col gap-3" aria-label="Findings">
            {findings.map(({ finding: f, key, location, assessment }) => (
              <li
                key={key}
                className="flex flex-wrap items-baseline gap-x-2 gap-y-1"
              >
                <Status value={f.severity} />
                <span className="min-w-0 break-words text-sm font-semibold">
                  {f.title}
                </span>
                <span className="break-all font-mono text-xs text-muted-foreground">
                  {location}
                </span>
                {editable && (
                  <Badge variant="outline">
                    {assessmentOptions.find((item) => item.value === assessment)
                      ?.label ?? "Unassessed"}
                  </Badge>
                )}
              </li>
            ))}
          </ul>
          <details
            open={defaultExpanded}
            className="min-w-0 rounded-lg border bg-card"
          >
            <summary className="cursor-pointer rounded-lg px-5 py-3 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring">
              View more
            </summary>
            <div className="flex min-w-0 flex-col gap-6 border-t p-5">
              {findings.map(
                ({ finding: f, index, key, location, assessment }) => (
                  <article key={key} className="flex min-w-0 flex-col gap-3">
                    <div className="flex flex-wrap items-start gap-2">
                      <Status value={f.severity} />
                      <h3 className="min-w-0 break-words text-sm font-semibold">
                        {f.title}
                      </h3>
                    </div>
                    <p className="break-all font-mono text-xs text-muted-foreground">
                      {location}
                    </p>
                    <ReviewMarkdown path={f.path}>{f.body}</ReviewMarkdown>
                    <ReviewMarkdown path={f.path}>
                      {f.failureScenario}
                    </ReviewMarkdown>
                    <div className="flex min-w-0 flex-col gap-2">
                      <h4 className="text-xs font-semibold">
                        Proposed fix
                        {f.replacement
                          ? ` · lines ${f.replacement.startLine}–${f.replacement.endLine}`
                          : ""}
                      </h4>
                      <ReviewMarkdown path={f.path}>
                        {f.suggestion}
                      </ReviewMarkdown>
                      {f.replacement && (
                        <ReviewCode
                          code={f.replacement.code}
                          language={fileLanguage(f.path)}
                        />
                      )}
                    </div>
                    {editable && (
                      <FieldGroup className="max-w-sm">
                        <Field data-disabled={busy}>
                          <FieldLabel htmlFor={`${controlId}-finding-${index}`}>
                            Finding assessment
                          </FieldLabel>
                          <Select<string>
                            items={assessmentOptions}
                            value={assessment ?? "unassessed"}
                            disabled={busy}
                            onValueChange={(value) => {
                              if (
                                value !== "unassessed" &&
                                value !== "confirmed" &&
                                value !== "potential_false_positive"
                              )
                                return;
                              void saveEvaluation({
                                findingIndex: index,
                                verdict: value === "unassessed" ? null : value,
                              });
                            }}
                          >
                            <SelectTrigger id={`${controlId}-finding-${index}`}>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectGroup>
                                {assessmentOptions.map((item) => (
                                  <SelectItem
                                    key={item.value}
                                    value={item.value}
                                  >
                                    {item.label}
                                  </SelectItem>
                                ))}
                              </SelectGroup>
                            </SelectContent>
                          </Select>
                        </Field>
                      </FieldGroup>
                    )}
                  </article>
                ),
              )}
            </div>
          </details>
        </>
      )}
    </section>
  );
}
