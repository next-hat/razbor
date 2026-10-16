"use client";

import { useEffect, useId, useState } from "react";
import Link from "next/link.js";

import {
  MAX_REPOSITORY_MCP_SERVERS,
  type McpServerView,
  type RepositoryMcpAccess,
} from "@razbor/contracts";

import { Alert, AlertDescription } from "@web/components/ui/alert.js";
import { Badge } from "@web/components/ui/badge.js";
import { Button } from "@web/components/ui/button.js";
import { Checkbox } from "@web/components/ui/checkbox.js";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@web/components/ui/field.js";

/** Selects whole-server tool access from the global library, with no grants by default. */
export function RepositoryMcp({
  repositoryId,
  initialAccess,
  initialServers,
}: Readonly<{
  repositoryId: string;
  initialAccess?: RepositoryMcpAccess;
  initialServers?: McpServerView[];
}>) {
  const id = useId();
  const [baseline, setBaseline] = useState(initialAccess);
  const [access, setAccess] = useState(initialAccess);
  const [servers, setServers] = useState(initialServers);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [retry, setRetry] = useState(0);
  const dirty =
    JSON.stringify(access?.serverIds) !== JSON.stringify(baseline?.serverIds);

  useEffect(() => {
    if (initialAccess && initialServers) return;
    const controller = new AbortController();
    setError("");
    Promise.all([
      fetch(`/api/repositories/${repositoryId}/mcp`, {
        signal: controller.signal,
        cache: "no-store",
      }).then(async (response) => {
        if (!response.ok) throw new Error("Unable to load MCP access.");
        return (await response.json()) as RepositoryMcpAccess;
      }),
      fetch("/api/mcp", { signal: controller.signal, cache: "no-store" }).then(
        async (response) => {
          if (!response.ok) throw new Error("Unable to load MCP servers.");
          return (await response.json()) as McpServerView[];
        },
      ),
    ])
      .then(([current, library]) => {
        if (controller.signal.aborted) return;
        setBaseline(current);
        setAccess(current);
        setServers(library);
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setError("Unable to load MCP access. Please try again.");
      });
    return () => controller.abort();
  }, [repositoryId, initialAccess, initialServers, retry]);

  /** Changes only the draft grant list, retaining disabled server selections. */
  function select(serverId: string, checked: boolean) {
    setAccess((current) =>
      current
        ? {
            serverIds: checked
              ? [...current.serverIds, serverId]
              : current.serverIds.filter((item) => item !== serverId),
          }
        : current,
    );
    setMessage("");
  }

  /** Saves explicit grants; removed grants revoke access for ongoing reviews. */
  async function save() {
    if (busy || !access || !dirty) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const response = await fetch(`/api/repositories/${repositoryId}/mcp`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(access),
      });
      const result = (await response.json()) as RepositoryMcpAccess & {
        error?: string;
      };
      if (!response.ok)
        throw new Error(result.error || "Unable to save MCP access.");
      setAccess(result);
      setBaseline(result);
      setMessage(
        "MCP access saved. New reviews use this selection. Removed access stops ongoing reviews from calling that server.",
      );
    } catch (error) {
      setError(
        error instanceof Error ? error.message : "Unable to save MCP access.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <section
        className="console-card grid min-w-0 gap-6 lg:grid-cols-[240px_minmax(0,1fr)]"
        aria-labelledby={`${id}-title`}
      >
        <div className="flex flex-col gap-2">
          <h2 id={`${id}-title`} className="text-base font-semibold">
            MCP access
          </h2>
          <p className="text-sm leading-relaxed text-muted-foreground">
            Choose the external servers available to this repository's reviewer.
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
          {error && (
            <Alert variant="destructive">
              <AlertDescription>
                <div className="flex flex-wrap items-center justify-between gap-4">
                  <span>{error}</span>
                  {(!access || !servers) && (
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => setRetry((value) => value + 1)}
                    >
                      Try again
                    </Button>
                  )}
                </div>
              </AlertDescription>
            </Alert>
          )}
          {!access || !servers ? (
            <output className="block text-sm text-muted-foreground">
              Loading MCP access…
            </output>
          ) : (
            <>
              <FieldGroup>
                <FieldSet>
                  <FieldLegend>Registered servers</FieldLegend>
                  <FieldDescription>
                    Select up to {MAX_REPOSITORY_MCP_SERVERS} servers from your{" "}
                    <Link href="/mcp">MCP server library</Link>. Each selection
                    grants access to all tools exposed by that server, including
                    any tools that make changes.
                  </FieldDescription>
                  {servers.length === 0 ? (
                    <FieldDescription>
                      No MCP servers connected. Connect an HTTP server in the
                      library to select it here.
                    </FieldDescription>
                  ) : (
                    servers.map((server) => (
                      <Field
                        key={server.id}
                        orientation="horizontal"
                        data-disabled={
                          busy ||
                          (!access.serverIds.includes(server.id) &&
                            access.serverIds.length >=
                              MAX_REPOSITORY_MCP_SERVERS)
                        }
                      >
                        <Checkbox
                          id={`${id}-${server.id}`}
                          checked={access.serverIds.includes(server.id)}
                          disabled={
                            busy ||
                            (!access.serverIds.includes(server.id) &&
                              access.serverIds.length >=
                                MAX_REPOSITORY_MCP_SERVERS)
                          }
                          onCheckedChange={(checked) =>
                            select(server.id, checked)
                          }
                        />
                        <FieldContent className="min-w-0">
                          <FieldLabel
                            htmlFor={`${id}-${server.id}`}
                            className="max-w-full flex-wrap break-all"
                          >
                            {server.name}
                            {!server.enabled && (
                              <Badge variant="secondary">
                                Disabled globally
                              </Badge>
                            )}
                          </FieldLabel>
                          <FieldDescription className="break-all">
                            {server.endpoint}
                          </FieldDescription>
                        </FieldContent>
                      </Field>
                    ))
                  )}
                </FieldSet>
              </FieldGroup>
              <p className="text-sm text-muted-foreground">
                Disabled servers retain their selection and cannot be called
                until enabled again.
              </p>
              <div>
                <Button type="submit" disabled={busy || !dirty}>
                  {busy ? "Saving…" : "Save MCP access"}
                </Button>
              </div>
              {message && <output className="block text-sm">{message}</output>}
            </>
          )}
        </form>
      </section>
    </>
  );
}
