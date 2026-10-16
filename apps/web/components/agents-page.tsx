"use client";

import { useEffect, useState } from "react";
import {
  Bot,
  CalendarDays,
  Cpu,
  GitBranch,
  KeyRound,
  Search,
  type LucideIcon,
} from "lucide-react";

import type { AgentView } from "@razbor/database";

import { AgentForm } from "@web/components/agent-form.js";
import { ConsoleHero } from "@web/components/console-hero.js";
import { formatUtc } from "@web/lib/date.js";
import { usePoll } from "@web/lib/use-poll.js";
import { Alert, AlertDescription } from "@web/components/ui/alert.js";
import { Badge } from "@web/components/ui/badge.js";
import { Button } from "@web/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@web/components/ui/dialog.js";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@web/components/ui/empty.js";
import { Field, FieldLabel } from "@web/components/ui/field.js";
import { Input } from "@web/components/ui/input.js";
import { Skeleton } from "@web/components/ui/skeleton.js";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@web/components/ui/table.js";

type AgentRepositoryAssignment = {
  agentId: string | null;
  status: "active" | "deleting";
};

/** Returns the latest valid save timestamp without treating an unavailable date as recent activity. */
function latestAgentSave(agents: AgentView[] | undefined) {
  let latest: string | undefined;
  let latestTimestamp = Number.NEGATIVE_INFINITY;
  for (const agent of agents ?? []) {
    const timestamp = Date.parse(agent.updatedAt);
    if (Number.isFinite(timestamp) && timestamp > latestTimestamp) {
      latest = agent.updatedAt;
      latestTimestamp = timestamp;
    }
  }
  return latest;
}

/** Shows an actual profile count, keeping its explanation at the bottom and marking capped repository counts as lower bounds. */
function AgentSummaryCard({
  label,
  value,
  detail,
  icon: Icon,
  tone,
  lowerBound = false,
}: Readonly<{
  label: string;
  value: number | undefined;
  detail: string;
  icon: LucideIcon;
  tone: "success" | "info" | "findings" | "tokens";
  lowerBound?: boolean;
}>) {
  return (
    <div className="flex min-h-24 min-w-0 gap-3 rounded-lg border bg-card p-4">
      <span
        className="overview-metric-icon flex size-9 shrink-0 items-center justify-center rounded-lg"
        data-tone={tone}
      >
        <Icon aria-hidden="true" className="size-5" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col">
        <h2 className="text-xs font-medium text-muted-foreground">{label}</h2>
        <p
          className="mt-1 break-all text-2xl font-semibold tracking-tight tabular-nums"
          title={
            lowerBound
              ? "At least this many assignments appear in the available repository snapshot."
              : undefined
          }
        >
          {value === undefined
            ? "—"
            : `${lowerBound ? "≥ " : ""}${value.toLocaleString("en-US")}`}
        </p>
        <p className="mt-auto pt-1 text-xs leading-relaxed text-muted-foreground">
          {detail}
        </p>
      </div>
    </div>
  );
}

/** Indicates whether a profile has stored credentials without exposing their value. */
function AgentKeyStatus({ hasApiKey }: Readonly<{ hasApiKey: boolean }>) {
  return (
    <Badge variant={hasApiKey ? "secondary" : "warning"}>
      <KeyRound />
      {hasApiKey ? "Stored" : "Missing"}
    </Badge>
  );
}

/**
 * Confirms profile removal and keeps server-side assignment or active-review conflicts
 * visible in the dialog.
 */
function DeleteAgent({
  agent,
  onDeleted,
}: Readonly<{ agent: AgentView; onDeleted: (id: string) => void }>) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  /**
   * Toggles the deletion dialog and clears prior errors while preventing dismissal
   * during deletion.
   */
  function changeOpen(value: boolean) {
    if (busy) return;
    setOpen(value);
    setError("");
  }

  /**
   * Deletes the profile, notifying the list only after the server accepts the
   * operation.
   */
  async function remove() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/agents/${agent.id}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
      });
      if (!response.ok) {
        const result = (await response.json()) as { error?: string };
        throw new Error(result.error || "Unable to delete agent");
      }
      setOpen(false);
      onDeleted(agent.id);
    } catch (error) {
      setError(
        error instanceof Error ? error.message : "Unable to delete agent",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogTrigger
        render={<Button variant="destructive" />}
        aria-label={`Delete ${agent.model}`}
      >
        Delete
      </DialogTrigger>
      <DialogContent showCloseButton={!busy}>
        <DialogHeader>
          <DialogTitle>Delete agent?</DialogTitle>
          <DialogDescription>
            Remove {agent.model} and its saved API key. Reassign any
            repositories and wait for its queued or running reviews to finish
            first.
          </DialogDescription>
        </DialogHeader>
        <p className="break-all text-sm text-muted-foreground">
          {agent.endpoint}
        </p>
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <DialogFooter>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => changeOpen(false)}
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={busy}
            onClick={() => void remove()}
          >
            {busy ? "Deleting…" : "Delete agent"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Displays public reviewer profiles and applies successful create, edit, and delete
 * operations to the local list.
 */
export function AgentsPage({
  initialData,
  initialRepositories,
}: Readonly<{
  initialData?: AgentView[];
  initialRepositories?: ReadonlyArray<AgentRepositoryAssignment>;
}>) {
  const [agents, setAgents] = useState(initialData);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [notice, setNotice] = useState("");
  const [search, setSearch] = useState("");
  const repositories = usePoll<ReadonlyArray<AgentRepositoryAssignment>>(
    "/api/repositories",
    initialRepositories,
    15_000,
  );
  const repositoryUsageAvailable =
    repositories.data !== undefined && !repositories.error;
  const cappedRepositorySnapshot = (repositories.data?.length ?? 0) >= 100;
  const assignmentCounts = new Map<string, number>(
    agents?.map((agent) => [agent.id, 0]),
  );
  for (const repository of repositories.data ?? []) {
    if (repository.agentId && assignmentCounts.has(repository.agentId)) {
      assignmentCounts.set(
        repository.agentId,
        (assignmentCounts.get(repository.agentId) ?? 0) + 1,
      );
    }
  }
  const assignedRepositories =
    agents && repositoryUsageAvailable
      ? [...assignmentCounts.values()].reduce(
          (total, count) => total + count,
          0,
        )
      : undefined;
  const modelsAvailable = agents
    ? new Set(agents.map((agent) => agent.model)).size
    : undefined;
  const storedKeys = agents?.filter((agent) => agent.hasApiKey).length;
  const lastSaved = latestAgentSave(agents);
  const query = search.trim().toLowerCase();
  const visibleAgents = agents?.filter((agent) =>
    `${agent.provider} ${agent.model} ${agent.endpoint}`
      .toLowerCase()
      .includes(query),
  );

  useEffect(() => {
    if (initialData) return;
    const controller = new AbortController();
    setError("");
    void fetch("/api/agents", { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("Unable to load agents.");
        const result = (await response.json()) as AgentView[];
        if (!controller.signal.aborted) setAgents(result);
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setError("Unable to load agents. Please try again.");
      });
    return () => controller.abort();
  }, [initialData, retry]);

  /**
   * Replaces an existing profile or appends a new one and announces the successful
   * save.
   */
  function saved(agent: AgentView) {
    setAgents((current) => {
      const existing = current?.some((item) => item.id === agent.id);
      return existing
        ? current?.map((item) => (item.id === agent.id ? agent : item))
        : [...(current ?? []), agent];
    });
    setNotice(`${agent.model} saved.`);
  }

  /** Removes the deleted profile from the visible list and announces the change. */
  function deleted(id: string) {
    setAgents((current) => current?.filter((agent) => agent.id !== id));
    setNotice("Agent deleted.");
  }

  return (
    <main className="console-hero-page agents-page flex min-w-0 flex-col">
      <ConsoleHero
        id="agents-title"
        eyebrow="AI review infrastructure"
        title="Agents"
        description="Manage model endpoints, review settings and credentials for your AI reviewers."
      >
        <span className="console-hero-status">
          <Bot aria-hidden="true" className="size-3.5 shrink-0" />
          <span className="tabular-nums">
            {agents?.length ?? "—"} configured
          </span>
        </span>
        {lastSaved && (
          <span className="console-hero-status">
            <CalendarDays aria-hidden="true" className="size-3.5 shrink-0" />
            Last saved {formatUtc(lastSaved)}
          </span>
        )}
      </ConsoleHero>
      <p role="status" className="sr-only">
        {notice}
      </p>
      <div className="console-container mt-6 mb-16 flex min-w-0 flex-col gap-5">
        <section
          aria-label="Agent totals"
          className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4"
        >
          <AgentSummaryCard
            label="Configured agents"
            value={agents?.length}
            detail="Stored reviewer profiles"
            icon={Bot}
            tone="success"
          />
          <AgentSummaryCard
            label="Models available"
            value={modelsAvailable}
            detail="Across configured agents"
            icon={Cpu}
            tone="tokens"
          />
          <AgentSummaryCard
            label="Assigned repositories"
            value={assignedRepositories}
            detail="Linked to a reviewer profile"
            icon={GitBranch}
            tone="findings"
            lowerBound={cappedRepositorySnapshot && repositoryUsageAvailable}
          />
          <AgentSummaryCard
            label="Stored API keys"
            value={storedKeys}
            detail="Profiles with saved credentials"
            icon={KeyRound}
            tone="info"
          />
        </section>
        {repositories.error && (
          <Alert>
            <AlertDescription>
              Repository usage is unavailable. Retrying…
            </AlertDescription>
          </Alert>
        )}
        {repositoryUsageAvailable && cappedRepositorySnapshot && (
          <Alert>
            <AlertDescription>
              The repository snapshot contains up to 100 accessible
              repositories. Assignment counts are lower bounds and may omit
              additional assignments.
            </AlertDescription>
          </Alert>
        )}
        <div className="agents-toolbar flex flex-wrap items-center justify-between gap-4">
          <Field className="w-full min-w-0 sm:max-w-md">
            <FieldLabel htmlFor="agent-search" className="sr-only">
              Search agents
            </FieldLabel>
            <div className="relative">
              <Search
                aria-hidden="true"
                className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
              />
              <Input
                id="agent-search"
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search model or endpoint…"
                disabled={!agents}
                className="pl-9"
              />
            </div>
          </Field>
          <AgentForm disabled={!agents} onSaved={saved} />
        </div>
        {error ? (
          <Alert variant="destructive">
            <AlertDescription>
              <div className="flex flex-wrap items-center justify-between gap-4">
                <span>{error}</span>
                <Button
                  variant="outline"
                  onClick={() => setRetry((value) => value + 1)}
                >
                  Try again
                </Button>
              </div>
            </AlertDescription>
          </Alert>
        ) : !agents ? (
          <div role="status">
            <span className="sr-only">Loading agents…</span>
            <Skeleton className="h-64 w-full" />
          </div>
        ) : !visibleAgents?.length ? (
          <Empty className="border bg-card py-12">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                {query ? <Search /> : <Bot />}
              </EmptyMedia>
              <EmptyTitle>
                {query ? "No matching agents" : "No agents registered"}
              </EmptyTitle>
              <EmptyDescription>
                {query
                  ? "Try another model identifier or endpoint URL."
                  : "Add an endpoint, model, and API key to register your first AI reviewer."}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="agents-table overflow-hidden rounded-lg border bg-card">
            <Table aria-label="Registered agents">
              <TableHeader>
                <TableRow>
                  <TableHead className="agents-model-cell">Model</TableHead>
                  <TableHead className="agents-endpoint-cell">
                    Endpoint
                  </TableHead>
                  <TableHead className="agents-key-cell">API key</TableHead>
                  <TableHead className="agents-usage-cell">Usage</TableHead>
                  <TableHead className="agents-updated-cell">
                    Last saved
                  </TableHead>
                  <TableHead className="agents-actions-cell">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visibleAgents.map((agent) => {
                  const assignmentCount = repositoryUsageAvailable
                    ? (assignmentCounts.get(agent.id) ?? 0)
                    : undefined;
                  return (
                    <TableRow key={agent.id}>
                      <TableCell
                        className="agents-model-cell"
                        data-label="Model"
                      >
                        <div className="flex min-w-0 items-center gap-3">
                          <span className="flex size-10 shrink-0 items-center justify-center rounded-lg border bg-muted/40 text-muted-foreground">
                            <Bot aria-hidden="true" className="size-5" />
                          </span>
                          <div className="min-w-0">
                            <div className="break-all font-semibold">
                              {agent.model}
                            </div>
                            <div className="text-xs text-muted-foreground">
                              {agent.provider === "anthropic"
                                ? "Anthropic Claude"
                                : "OpenAI Responses"}
                              {agent.provider !== "anthropic" && (
                                <>
                                  {" · "}
                                  <span className="capitalize">
                                    {agent.reasoningEffort ?? "high"}
                                  </span>
                                  {" reasoning"}
                                </>
                              )}
                            </div>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell
                        className="agents-endpoint-cell"
                        data-label="Endpoint"
                      >
                        <span className="break-all text-muted-foreground">
                          {agent.endpoint}
                        </span>
                      </TableCell>
                      <TableCell
                        className="agents-key-cell"
                        data-label="API key"
                      >
                        <AgentKeyStatus hasApiKey={agent.hasApiKey} />
                      </TableCell>
                      <TableCell
                        className="agents-usage-cell"
                        data-label="Usage"
                      >
                        <span
                          className="text-xs tabular-nums text-muted-foreground"
                          title={
                            assignmentCount === undefined
                              ? "Repository usage is unavailable."
                              : cappedRepositorySnapshot
                                ? "At least this many assignments appear in the available repository snapshot; additional assignments may be omitted."
                                : "Repository assignments in the available snapshot, including repositories being deleted."
                          }
                        >
                          {assignmentCount === undefined
                            ? "—"
                            : `${cappedRepositorySnapshot ? "≥ " : ""}${assignmentCount.toLocaleString("en-US")} ${assignmentCount === 1 ? "repository" : "repositories"}`}
                        </span>
                      </TableCell>
                      <TableCell
                        className="agents-updated-cell"
                        data-label="Last saved"
                      >
                        <span className="text-xs text-muted-foreground">
                          {formatUtc(agent.updatedAt)}
                        </span>
                      </TableCell>
                      <TableCell
                        className="agents-actions-cell"
                        data-label="Actions"
                      >
                        <div className="flex flex-wrap items-center justify-end gap-2">
                          <AgentForm agent={agent} onSaved={saved} />
                          <DeleteAgent agent={agent} onDeleted={deleted} />
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
        <section
          aria-labelledby="agents-how-it-works"
          className="flex flex-col gap-5 rounded-lg border bg-card p-5 xl:grid xl:grid-cols-[minmax(0,1.3fr)_minmax(0,2fr)] xl:items-center"
        >
          <div>
            <h2 id="agents-how-it-works" className="text-lg font-semibold">
              How agents work
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Profiles define the model endpoint and credential used when a
              repository selects an AI reviewer.
            </p>
          </div>
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
            <div className="flex items-start gap-3">
              <Cpu
                aria-hidden="true"
                className="mt-0.5 size-5 shrink-0 text-primary"
              />
              <div>
                <h3 className="text-sm font-medium">Model endpoints</h3>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  Each profile saves an OpenAI Responses or Anthropic Messages
                  endpoint and a model identifier for automated reviews.
                </p>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <GitBranch
                aria-hidden="true"
                className="mt-0.5 size-5 shrink-0 text-primary"
              />
              <div>
                <h3 className="text-sm font-medium">Repository assignments</h3>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  Assign a saved agent in repository settings to use that
                  reviewer profile for its reviews.
                </p>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <KeyRound
                aria-hidden="true"
                className="mt-0.5 size-5 shrink-0 text-primary"
              />
              <div>
                <h3 className="text-sm font-medium">Stored credentials</h3>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  Saved keys are not shown. A Stored badge confirms presence; it
                  does not verify that a credential is valid.
                </p>
              </div>
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}
