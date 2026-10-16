"use client";

import { useId, useState, type ReactNode } from "react";
import Link from "next/link.js";
import { Copy, GitBranch, RotateCw } from "lucide-react";

import type { RunnerView } from "@razbor/contracts";
import type { getRepository, webhookView } from "@razbor/database";

import { ConsoleHero } from "@web/components/console-hero.js";
import { RunnerForm } from "@web/components/runner-form.js";
import { Status } from "@web/components/status.js";
import { RemoteWebhookSetup } from "@web/components/webhook-settings.js";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@web/components/ui/alert.js";
import { Badge } from "@web/components/ui/badge.js";
import { Button, buttonVariants } from "@web/components/ui/button.js";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@web/components/ui/empty.js";
import { Field, FieldGroup, FieldLabel } from "@web/components/ui/field.js";
import { Input } from "@web/components/ui/input.js";
import { formatUtc } from "@web/lib/date.js";
import type { runnerData } from "@web/lib/runners.js";
import { usePoll } from "@web/lib/use-poll.js";

type Repository = NonNullable<Awaited<ReturnType<typeof getRepository>>>;

type Hook = Awaited<ReturnType<typeof webhookView>>;

const indexLabels = {
  pending: "Pending",
  indexing: "Indexing",
  ready: "Ready",
  error: "Needs attention",
};

/** Displays one setup requirement, its current evidence, and its recovery action. */
function SetupItem({
  title,
  status,
  children,
  action,
}: Readonly<{
  title: string;
  status: ReactNode;
  children: ReactNode;
  action?: ReactNode;
}>) {
  return (
    <li className="flex flex-col gap-3 py-4 first:pt-0 last:pb-0 sm:flex-row sm:items-start sm:justify-between">
      <div className="flex min-w-0 flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-medium">{title}</h3>
          {status}
        </div>
        <p className="break-words text-sm leading-relaxed text-muted-foreground">
          {children}
        </p>
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </li>
  );
}

/**
 * Tracks a newly connected repository; only super admins can enroll or assign runners.
 * The generated webhook secret is displayed only for this mounted completion screen.
 */
export function RepositorySetup({
  id,
  generatedSecret,
  canManageRunners = false,
  canManageIndexer = false,
}: Readonly<{
  id: string;
  generatedSecret?: string;
  canManageRunners?: boolean;
  canManageIndexer?: boolean;
}>) {
  const secretId = useId();
  const repository = usePoll<Repository>(`/api/repositories/${id}`);
  const webhook = usePoll<Hook>(`/api/repositories/${id}/webhook`);
  const runners = usePoll<Awaited<ReturnType<typeof runnerData>>>(
    canManageRunners ? "/api/runners" : null,
  );
  const [secret, setSecret] = useState(generatedSecret ?? "");
  const [copyMessage, setCopyMessage] = useState("");
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState("");
  const repo = repository.data;
  const hook = webhook.data;
  const assigned = runners.data?.runners.filter(
    (runner) => runner.allRepositories || runner.repositoryIds.includes(id),
  );
  const available = assigned?.filter((runner) => runner.status === "online");
  const busy = assigned?.some((runner) => runner.status === "busy");
  const name = repo?.metadata?.fullPath ?? repo?.selector ?? "Repository";
  const settings = `/repos/${id}/settings`;
  const repositoryChoices = runners.data?.repositories ?? [];
  const choices = repositoryChoices.some((repository) => repository.id === id)
    ? repositoryChoices
    : [...repositoryChoices, { id, name }];

  /** Copies the one-time secret without persisting it or including it in errors. */
  async function copySecret() {
    try {
      await navigator.clipboard.writeText(secret);
      setCopyMessage("Webhook secret copied.");
    } catch {
      setCopyMessage("Select and copy the secret above.");
    }
  }

  /** Retries the existing webhook and initial indexing setup without recreating it. */
  async function retrySetup() {
    if (retrying) return;
    setRetrying(true);
    setRetryError("");
    try {
      const response = await fetch(`/api/repositories/${id}/setup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const result = (await response.json()) as Repository & { error?: string };
      if (!response.ok)
        throw new Error(result.error || "Unable to retry repository setup.");
      repository.setData(result);
    } catch (error) {
      setRetryError(
        error instanceof Error ? error.message : "Unable to retry setup.",
      );
    } finally {
      setRetrying(false);
    }
  }

  /** Updates the runner list in place so an open enrollment dialog keeps its token. */
  function runnerSaved(runner: RunnerView) {
    runners.setData((current) =>
      current
        ? {
            ...current,
            runners: current.runners.some((item) => item.id === runner.id)
              ? current.runners.map((item) =>
                  item.id === runner.id ? runner : item,
                )
              : [...current.runners, runner],
          }
        : current,
    );
  }

  return (
    <main className="console-hero-page repository-setup-page flex min-w-0 flex-col">
      <ConsoleHero
        id="repository-setup-title"
        eyebrow="Repository connected"
        title="Setup"
        breadcrumbLabel="Setup"
        breadcrumbs={[{ label: "Repositories", href: "/repos" }]}
        description="Finish the setup checklist. Indexing continues if you leave this page."
      >
        <span className="console-hero-status min-w-0 max-w-full">
          <GitBranch className="size-4 shrink-0" aria-hidden="true" />
          <span className="min-w-0 truncate" title={name}>
            {name}
          </span>
        </span>
      </ConsoleHero>
      <div className="console-container mt-6 mb-16 flex min-w-0 flex-col gap-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="min-w-0 break-words text-sm text-muted-foreground">
            The repository is saved. Complete the remaining requirements below.
          </p>
          <Link
            href={`/repos/${id}`}
            className={buttonVariants({ variant: "outline", size: "lg" })}
          >
            Open repository
          </Link>
        </div>
        {secret && (
          <section
            className="console-card flex min-w-0 flex-col gap-4"
            aria-labelledby={`${secretId}-title`}
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 id={`${secretId}-title`} className="font-semibold">
                Save your webhook secret
              </h2>
              <Badge variant="warning">Shown once</Badge>
            </div>
            <p className="text-sm leading-relaxed text-muted-foreground">
              {hook?.mode === "manual"
                ? "Copy this secret into the Secret field when adding your GitHub webhook below. "
                : "razbor saved this signing secret. Copy it now if you need to configure the forge webhook manually. "}
              It cannot be retrieved after leaving this page or dismissing it.
            </p>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor={secretId}>
                  Generated webhook secret
                </FieldLabel>
                <Input
                  id={secretId}
                  value={secret}
                  readOnly
                  autoComplete="off"
                  spellCheck={false}
                />
              </Field>
            </FieldGroup>
            <div className="flex flex-wrap items-center gap-3">
              <Button variant="outline" onClick={() => void copySecret()}>
                <Copy data-icon="inline-start" />
                Copy secret
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  setSecret("");
                  setCopyMessage("");
                }}
              >
                Dismiss secret
              </Button>
              <p className="text-xs text-muted-foreground" role="status">
                {copyMessage}
              </p>
            </div>
          </section>
        )}
        {hook?.mode === "manual" && <RemoteWebhookSetup hook={hook} />}
        {(repository.error ||
          webhook.error ||
          (canManageRunners && runners.error)) && (
          <Alert variant="destructive">
            <AlertTitle>Status refresh unavailable</AlertTitle>
            <AlertDescription>
              Some setup details could not be refreshed. The last known values
              remain below; retrying automatically.
            </AlertDescription>
          </Alert>
        )}
        <section
          className="console-card flex min-w-0 flex-col gap-4"
          aria-labelledby="repository-setup-checklist"
        >
          <h2 id="repository-setup-checklist" className="font-semibold">
            Setup checklist
          </h2>
          <ul className="divide-y">
            <SetupItem
              title="Repository access"
              status={
                <Badge variant={repo?.verifiedAt ? "success" : "outline"}>
                  {repo?.verifiedAt ? "Verified at registration" : "Checking"}
                </Badge>
              }
              action={
                <Link
                  href={settings}
                  className={buttonVariants({ variant: "outline", size: "sm" })}
                >
                  Connection settings
                </Link>
              }
            >
              {repo?.verifiedAt
                ? `Repository access was checked ${formatUtc(repo.verifiedAt)}.`
                : "Loading the saved access verification."}
            </SetupItem>
            <SetupItem
              title="Webhook configuration"
              status={
                <Status
                  value={
                    hook?.setup === "manual"
                      ? "awaiting delivery"
                      : (hook?.setup ??
                        (hook === null ? "not configured" : "loading"))
                  }
                />
              }
              action={
                <Link
                  href={`${settings}/webhook`}
                  className={buttonVariants({ variant: "outline", size: "sm" })}
                >
                  Webhook settings
                </Link>
              }
            >
              {hook?.setup === "ready"
                ? hook.mode === "manual"
                  ? "A signed GitHub delivery verified your webhook configuration."
                  : "The forge webhook is configured. Delivery is checked separately below."
                : hook?.mode === "manual"
                  ? "Add the webhook on GitHub using the instructions above. A signed ping or repository event completes this step."
                  : hook?.mode === "github-app"
                    ? "razbor is checking your GitHub App installation and repository access."
                    : "Automatic setup must complete before the forge can send authenticated review requests."}
            </SetupItem>
            <SetupItem
              title="Webhook delivery"
              status={
                <Badge
                  variant={
                    hook?.lastDelivery === "accepted"
                      ? "success"
                      : hook?.lastDelivery === "failed"
                        ? "destructive"
                        : "outline"
                  }
                >
                  {hook?.lastDelivery ?? "Awaiting first delivery"}
                </Badge>
              }
            >
              {hook?.lastDeliveryAt
                ? `Last delivery: ${formatUtc(hook.lastDeliveryAt)}.`
                : "No delivery has been observed yet. A permitted comment on a pull or merge request will exercise the webhook."}
            </SetupItem>
            <SetupItem
              title="Initial index"
              status={
                <Badge
                  variant={
                    repo?.setupState === "ready"
                      ? "success"
                      : repo?.setupState === "error"
                        ? "destructive"
                        : "outline"
                  }
                >
                  {repo ? indexLabels[repo.setupState] : "Loading"}
                </Badge>
              }
              action={
                canManageIndexer && (
                  <Link
                    href={`${settings}/index`}
                    className={buttonVariants({
                      variant: "outline",
                      size: "sm",
                    })}
                  >
                    Index settings
                  </Link>
                )
              }
            >
              {repo?.setupError ??
                (repo?.setupState === "ready"
                  ? "The repository index is ready."
                  : "The indexer prepares the repository in the background.")}
            </SetupItem>
            <SetupItem
              title="Reviewer"
              status={
                <Badge variant={repo?.agent ? "success" : "warning"}>
                  {repo?.agent
                    ? "Agent selected"
                    : repo
                      ? "Runner default: verify configuration"
                      : "Loading"}
                </Badge>
              }
              action={
                <Link
                  href={`${settings}/reviewer`}
                  className={buttonVariants({ variant: "outline", size: "sm" })}
                >
                  Reviewer settings
                </Link>
              }
            >
              {repo?.agent
                ? `${repo.agent.model} is selected. Model access will be exercised by a review.`
                : "Runner default requires model credentials on the assigned runner. This screen cannot verify that fallback configuration; select an agent in reviewer settings if needed."}
            </SetupItem>
            <SetupItem
              title="Assigned runner"
              status={
                <Badge
                  variant={
                    !canManageRunners
                      ? "outline"
                      : available?.length
                        ? "success"
                        : "warning"
                  }
                >
                  {!canManageRunners
                    ? "Instance managed"
                    : !runners.data
                      ? "Loading"
                      : available?.length
                        ? "Available"
                        : busy
                          ? "Busy"
                          : assigned?.length
                            ? "Not ready"
                            : "Not assigned"}
                </Badge>
              }
            >
              {!canManageRunners
                ? "Ask a super admin to confirm a ready runner is assigned to this repository. A runner executes reviews; the indexer does not replace it."
                : available?.length
                  ? `${available.map((runner) => runner.name).join(", ")} has available review capacity. The reviewer must also be configured.`
                  : busy
                    ? "An assigned runner is connected, but all of its review slots are occupied."
                    : assigned?.length
                      ? "An assigned runner must be enrolled, online, and healthy to accept a review."
                      : "Register a runner or assign an existing host below. A runner executes reviews; the indexer does not replace it."}
            </SetupItem>
          </ul>
          {(repo?.setupState === "error" ||
            (hook &&
              !["ready", "pending", "disabled"].includes(hook.setup))) && (
            <div className="flex flex-col gap-3">
              {retryError && (
                <Alert variant="destructive">
                  <AlertDescription>{retryError}</AlertDescription>
                </Alert>
              )}
              <div>
                <Button
                  variant="outline"
                  disabled={retrying || repo?.status === "deleting"}
                  onClick={() => void retrySetup()}
                >
                  <RotateCw data-icon="inline-start" />
                  {retrying ? "Retrying…" : "Retry setup"}
                </Button>
              </div>
            </div>
          )}
        </section>
        {canManageRunners && (
          <section
            className="console-card flex min-w-0 flex-col gap-4"
            aria-labelledby="repository-setup-runner"
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 id="repository-setup-runner" className="font-semibold">
                Set up a runner
              </h2>
              <RunnerForm
                repositories={choices}
                defaultRepositoryIds={[id]}
                disabled={
                  !runners.data || runners.error || repo?.status === "deleting"
                }
                onSaved={runnerSaved}
              />
            </div>
            <p className="text-sm leading-relaxed text-muted-foreground">
              This repository is preselected when registering or managing a
              runner. Save its assignments, then run the enrollment command on
              your host for a new runner.
            </p>
            {runners.data?.runners.length === 0 && (
              <Empty>
                <EmptyHeader>
                  <EmptyTitle>No runners registered</EmptyTitle>
                  <EmptyDescription>
                    Register your first runner above to get a one-time
                    enrollment command without leaving setup.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            )}
            {runners.data && runners.data.runners.length > 0 && (
              <ul className="flex flex-col divide-y">
                {runners.data.runners.map((runner) => (
                  <li
                    key={runner.id}
                    className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0"
                  >
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                      <span className="break-all text-sm font-medium">
                        {runner.name}
                      </span>
                      <Status value={runner.status} />
                      {(runner.allRepositories ||
                        runner.repositoryIds.includes(id)) && (
                        <Badge variant="secondary">Assigned</Badge>
                      )}
                    </div>
                    <RunnerForm
                      runner={runner}
                      repositories={choices}
                      defaultRepositoryIds={[id]}
                      disabled={runners.error || repo?.status === "deleting"}
                      onSaved={runnerSaved}
                    />
                  </li>
                ))}
              </ul>
            )}
            <div>
              <Link
                href="/runners"
                className={buttonVariants({ variant: "outline" })}
              >
                All runners
              </Link>
            </div>
          </section>
        )}
        <Alert>
          <AlertTitle>Request your first review</AlertTitle>
          <AlertDescription>
            {repo?.reviewCommand ? (
              <>
                Once the webhook and index are ready and a runner is available
                with a configured reviewer, open a pull or merge request and
                comment <code>{repo.reviewCommand}</code> as a permitted user.
                The bot ignores its own comments.
              </>
            ) : (
              "The review command will appear when repository access is available."
            )}
          </AlertDescription>
        </Alert>
      </div>
    </main>
  );
}
