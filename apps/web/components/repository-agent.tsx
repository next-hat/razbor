"use client";

import { useState } from "react";

import type { AgentView, getRepository } from "@razbor/database";

import { AgentSelect } from "@web/components/agent-select.js";
import { Alert, AlertDescription } from "@web/components/ui/alert.js";
import { Button } from "@web/components/ui/button.js";
import { FieldGroup } from "@web/components/ui/field.js";

type Repository = NonNullable<Awaited<ReturnType<typeof getRepository>>>;

/**
 * Displays and edits the reviewer assigned to future reviews without changing the
 * existing review history.
 */
export function RepositoryAgent({
  initialRepository,
  initialAgents,
  canCreate = false,
}: Readonly<{
  initialRepository: Repository;
  initialAgents?: AgentView[];
  canCreate?: boolean;
}>) {
  const [repository, setRepository] = useState(initialRepository);
  const [agentId, setAgentId] = useState(initialRepository.agentId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  /**
   * Persists a changed reviewer assignment and updates the displayed repository after
   * a successful response.
   */
  async function save() {
    if (busy || agentId === repository.agentId) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const response = await fetch(`/api/repositories/${repository.id}/agent`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId }),
      });
      if (!response.ok) {
        const result = (await response.json()) as { error?: string };
        throw new Error(result.error || "Unable to save AI reviewer");
      }
      setRepository((await response.json()) as Repository);
      setMessage("AI reviewer saved. New reviews will use this selection.");
    } catch (error) {
      setError(
        error instanceof Error ? error.message : "Unable to save AI reviewer",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <section
        className="console-card grid min-w-0 gap-6 lg:grid-cols-[240px_minmax(0,1fr)]"
        aria-labelledby="repository-agent-title"
      >
        <div className="flex flex-col gap-2">
          <h2 id="repository-agent-title" className="text-base font-semibold">
            AI reviewer
          </h2>
          <p className="text-sm leading-relaxed text-muted-foreground">
            Select the agent that reviews changes in this repository.
          </p>
        </div>
        <form
          className="flex min-w-0 flex-col gap-4"
          aria-busy={busy}
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <div className="flex min-w-0 flex-col gap-1">
            <p className="break-all font-medium">
              {repository.agent?.model ?? "Runner default"}
            </p>
            {repository.agent && (
              <p className="break-all text-xs text-muted-foreground">
                {repository.agent.endpoint}
              </p>
            )}
          </div>
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <FieldGroup>
            <AgentSelect
              initialAgents={initialAgents}
              currentAgent={repository.agent}
              value={agentId}
              onValueChange={(value) => {
                setAgentId(value);
                setMessage("");
              }}
              disabled={busy}
              allowCreate={canCreate}
            />
          </FieldGroup>
          <div>
            <Button
              type="submit"
              disabled={busy || agentId === repository.agentId}
            >
              {busy ? "Saving…" : "Save reviewer"}
            </Button>
          </div>
          {message && <output className="block text-sm">{message}</output>}
        </form>
      </section>
    </>
  );
}
