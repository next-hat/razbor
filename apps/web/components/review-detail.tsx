"use client";

import Link from "next/link.js";
import { ArrowUpRight } from "lucide-react";

import type { ReviewJobView } from "@razbor/contracts";
import type { publicationView } from "@razbor/database";
import {
  reviewDisplayName,
  safeReviewUrl,
} from "@razbor/contracts/presentation";

import { ReviewResult } from "@web/components/review-result.js";
import { ConsoleHero } from "@web/components/console-hero.js";
import { useReviewStream } from "@web/lib/use-review-stream.js";
import { ReviewLog } from "@web/components/review-log.js";
import { Status } from "@web/components/status.js";
import { Alert, AlertDescription } from "@web/components/ui/alert.js";
import { Button } from "@web/components/ui/button.js";
import { Skeleton } from "@web/components/ui/skeleton.js";

/**
 * Distinguishes API submission from acknowledged or still-pending forge comment
 * requests.
 */
function acknowledgementLabel(
  interaction: Awaited<ReturnType<typeof publicationView>> | undefined,
) {
  if (!interaction) return "Submitted through the API";
  return interaction.acknowledged
    ? "Request acknowledged"
    : "Acknowledgement pending";
}

/**
 * Displays the streamed review result and publication status for granted accounts.
 * Administrators also see execution details and can curate evaluation marks.
 */
export default function ReviewPage({
  id,
  initialData,
  isAdmin = false,
}: Readonly<{
  id: string;
  isAdmin?: boolean;
  initialData?: ReviewJobView & {
    interaction: Awaited<ReturnType<typeof publicationView>>;
  };
}>) {
  const { job, lines, connection, logsAvailable } = useReviewStream(
    id,
    initialData,
  );
  const error = connection === "reconnecting";
  const p = job?.interaction?.publication;
  return (
    <main className="console-hero-page flex min-w-0 flex-col">
      <ConsoleHero
        id="review-title"
        eyebrow="Review activity"
        title="Review"
        description="Inspect findings, publication status, and the recorded review run."
        breadcrumbLabel="Review"
        breadcrumbs={
          job?.repositoryId
            ? [
                { label: "Repositories", href: "/repos" },
                { label: "Reviews", href: `/repos/${job.repositoryId}` },
              ]
            : []
        }
      >
        {job && (
          <>
            <span className="console-hero-status">
              <Status value={job.status} />
            </span>
            {p && (
              <span className="console-hero-status">
                <Status
                  value={p.state === "failed" ? "publication failed" : p.state}
                />
              </span>
            )}
          </>
        )}
      </ConsoleHero>
      <div className="console-container mt-6 mb-16 flex min-w-0 flex-col gap-6">
        <section className="console-card flex flex-col gap-4">
          <div className="flex flex-col gap-4 sm:flex-row sm:flex-wrap sm:items-start sm:justify-between">
            <div className="min-w-0 flex-1">
              <h2 className="break-words text-2xl font-semibold tracking-tight">
                {job
                  ? reviewDisplayName({
                      ...job,
                      changeTitle:
                        job.changeTitle ?? job.interaction?.change.title,
                      headSha: job.headSha ?? job.interaction?.change.headSha,
                    })
                  : "Review details"}
              </h2>
              {job && (
                <p className="mt-2 text-sm text-muted-foreground">
                  {acknowledgementLabel(job.interaction)}
                </p>
              )}
            </div>
            {job?.interaction && (
              <Button
                className="self-start"
                variant="outline"
                nativeButton={false}
                render={
                  <a
                    href={safeReviewUrl(job.interaction.change.url)}
                    target="_blank"
                    rel="noopener noreferrer"
                  />
                }
              >
                Open pull request
                <ArrowUpRight data-icon="inline-end" />
              </Button>
            )}
          </div>
          <dl className="grid gap-4 text-sm md:grid-cols-2">
            <div>
              <dt className="text-xs text-muted-foreground">
                {job?.headSha || job?.interaction
                  ? "Reviewed commit"
                  : "Review ID"}
              </dt>
              <dd className="mt-1 break-all font-mono text-xs leading-5">
                {job?.headSha ?? job?.interaction?.change.headSha ?? id}
              </dd>
            </div>
            {isAdmin && job?.agent && (
              <div>
                <dt className="text-xs text-muted-foreground">Reviewer</dt>
                <dd className="mt-1 break-all text-xs leading-5">
                  {job.agent.model} · {job.agent.endpoint}
                  {job.agent.provider !== "anthropic" &&
                    job.agent.reasoningEffort && (
                      <>
                        {" · "}
                        <span className="capitalize">
                          {job.agent.reasoningEffort}
                        </span>
                        {" reasoning"}
                      </>
                    )}
                </dd>
              </div>
            )}
            {isAdmin && p?.remoteId && (
              <div>
                <dt className="text-xs text-muted-foreground">
                  Provider publication
                </dt>
                <dd className="mt-1 break-all text-xs leading-5">
                  {p.remoteId} · {p.inlineIds?.length ?? 0} inline comments
                </dd>
              </div>
            )}
          </dl>
        </section>
        {error && (
          <Alert variant="destructive">
            <AlertDescription>Review unavailable. Retrying…</AlertDescription>
          </Alert>
        )}
        {!job && !error ? (
          <Skeleton className="h-40 w-full" />
        ) : (
          job && (
            <>
              {(job.error ||
                p?.error ||
                job.interaction?.acknowledgementError) && (
                <Alert variant="destructive">
                  <AlertDescription>
                    {job.error ??
                      p?.error ??
                      job.interaction?.acknowledgementError}
                  </AlertDescription>
                </Alert>
              )}
              {p?.limitations?.length ? (
                <Alert>
                  <AlertDescription>
                    <p>Publication limitations</p>
                    <ul className="list-inside list-disc">
                      {p.limitations.map((l) => (
                        <li key={l}>{l}</li>
                      ))}
                    </ul>
                  </AlertDescription>
                </Alert>
              ) : null}
              {isAdmin && job.status === "queued" && job.waitingForRunner && (
                <Alert>
                  <AlertDescription>
                    No eligible runner is available. In{" "}
                    <Link
                      href="/runners"
                      className="underline underline-offset-4"
                    >
                      Runners
                    </Link>
                    , assign this repository to a ready host with free capacity
                    and resume it if drained.
                    {!job.agent &&
                      " This review has no saved AI reviewer; it needs a runner with a local model connection, or a new review after assigning an AI reviewer."}
                  </AlertDescription>
                </Alert>
              )}
              {isAdmin && job.guidance && (
                <section className="console-card flex flex-col gap-2 text-sm">
                  <h2 className="font-medium">Instructions and skills</h2>
                  <p className="text-muted-foreground">
                    Repository instructions:{" "}
                    {job.guidance.repositoryInstructions === undefined
                      ? "runner default"
                      : job.guidance.repositoryInstructions
                        ? "enabled"
                        : "disabled"}
                    {" · "}Repository skills:{" "}
                    {job.guidance.repositorySkills ? "enabled" : "disabled"}.
                    Repository guidance uses the base commit.
                  </p>
                  {job.guidance.skills.length > 0 && (
                    <ul className="flex flex-wrap gap-x-4 gap-y-1">
                      {job.guidance.skills.map((skill) => (
                        <li key={skill.id}>
                          <code>{skill.name}</code>
                          {" · "}v{skill.version}
                          {" · "}
                          {job.guidance?.alwaysIncludeSkillIds?.includes(
                            skill.id,
                          )
                            ? "Always include"
                            : "On demand"}
                        </li>
                      ))}
                    </ul>
                  )}
                  <p className="text-xs text-muted-foreground">
                    These settings are saved with this review. Loaded
                    instruction sources, included skills, and skill reads appear
                    in the execution log.
                  </p>
                </section>
              )}
              {isAdmin && (
                <ReviewLog
                  lines={lines}
                  job={job}
                  connection={connection}
                  available={logsAvailable}
                />
              )}
              <div aria-live="polite" aria-atomic="true" className="min-w-0">
                {job.review ? (
                  <ReviewResult
                    key={id}
                    review={job.review}
                    reviewId={
                      isAdmin && job.status === "completed" ? id : undefined
                    }
                    evaluation={job.evaluation}
                  />
                ) : (
                  <p className="console-card text-sm text-muted-foreground">
                    {job.status === "failed"
                      ? "The review did not produce a result."
                      : "Results will appear here and be posted to the pull request automatically."}
                  </p>
                )}
              </div>
            </>
          )
        )}
      </div>
    </main>
  );
}
