"use client";

import { useId, useState } from "react";
import { Plus } from "lucide-react";

import type { McpServerView } from "@razbor/contracts";

import { Alert, AlertDescription } from "@web/components/ui/alert.js";
import { Button } from "@web/components/ui/button.js";
import { Checkbox } from "@web/components/ui/checkbox.js";
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
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@web/components/ui/field.js";
import { Input } from "@web/components/ui/input.js";

/** Registers or edits HTTP endpoints while retaining credentials unless explicitly replaced. */
export function McpForm({
  server,
  disabled,
  onSaved,
  onBusyChange,
}: Readonly<{
  server?: McpServerView;
  disabled?: boolean;
  onSaved: (server: McpServerView) => void;
  onBusyChange?: (busy: boolean) => void;
}>) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(!server);
  const [baseline, setBaseline] = useState(server);
  const [name, setName] = useState(server?.name ?? "");
  const [endpoint, setEndpoint] = useState(server?.endpoint ?? "");
  const [enabled, setEnabled] = useState(server?.enabled ?? true);
  const [token, setToken] = useState("");
  const [clearToken, setClearToken] = useState(false);
  const [error, setError] = useState("");
  const dirty = baseline
    ? name !== baseline.name ||
      endpoint !== baseline.endpoint ||
      enabled !== baseline.enabled ||
      !!token ||
      clearToken
    : !!name || !!endpoint || !!token || !enabled;

  /** Coordinates row actions with loading or saving this registration. */
  function changeBusy(value: boolean) {
    setBusy(value);
    onBusyChange?.(value);
  }

  /** Resets sensitive fields and loads current redacted settings when editing. */
  async function changeOpen(value: boolean) {
    if (busy) return;
    if (
      !value &&
      dirty &&
      !window.confirm("Discard your unsaved MCP server changes?")
    )
      return;
    setOpen(value);
    setError("");
    setToken("");
    setClearToken(false);
    setName(server?.name ?? "");
    setEndpoint(server?.endpoint ?? "");
    setEnabled(server?.enabled ?? true);
    setBaseline(server);
    setLoaded(!server);
    if (!value || !server) return;
    changeBusy(true);
    try {
      const response = await fetch(`/api/mcp/${server.id}`, {
        cache: "no-store",
      });
      if (!response.ok)
        throw new Error(
          "Unable to load this MCP server. Close the dialog and try again.",
        );
      const current = (await response.json()) as McpServerView;
      setName(current.name);
      setEndpoint(current.endpoint);
      setEnabled(current.enabled);
      setBaseline(current);
      setLoaded(true);
    } catch (error) {
      setError(
        error instanceof Error ? error.message : "Unable to load MCP server.",
      );
    } finally {
      changeBusy(false);
    }
  }

  /** Persists settings without sending an empty token unless removal was requested. */
  async function save() {
    if (busy || !loaded) return;
    changeBusy(true);
    setError("");
    try {
      const response = await fetch(
        server ? `/api/mcp/${server.id}` : "/api/mcp",
        {
          method: server ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name,
            endpoint,
            enabled,
            ...(clearToken ? { token: "" } : token ? { token } : {}),
          }),
        },
      );
      const result = (await response.json()) as McpServerView & {
        error?: string;
      };
      if (!response.ok)
        throw new Error(result.error || "Unable to save MCP server.");
      setToken("");
      setClearToken(false);
      setOpen(false);
      onSaved(result);
    } catch (error) {
      setError(
        error instanceof Error ? error.message : "Unable to save MCP server.",
      );
    } finally {
      changeBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(value) => void changeOpen(value)}>
      <DialogTrigger
        render={
          <Button
            variant={server ? "outline" : "default"}
            disabled={disabled || busy}
          />
        }
      >
        {!server && <Plus data-icon="inline-start" />}
        {server ? "Edit" : "Connect server"}
      </DialogTrigger>
      <DialogContent
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg"
        showCloseButton={!busy}
      >
        <DialogHeader>
          <DialogTitle>
            {server ? "Edit MCP server" : "Connect MCP server"}
          </DialogTitle>
          <DialogDescription>
            Connect an existing Streamable HTTP server. Select it in repository
            settings to grant access to its tools.
          </DialogDescription>
        </DialogHeader>
        <form
          id={id}
          className="flex flex-col gap-4"
          aria-busy={busy}
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <FieldGroup>
            <Field data-disabled={busy || !loaded}>
              <FieldLabel htmlFor={`${id}-name`}>Name</FieldLabel>
              <Input
                id={`${id}-name`}
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="my-server"
                maxLength={32}
                pattern="[a-z0-9]+(-[a-z0-9]+)*"
                required
                disabled={busy || !loaded}
                autoComplete="off"
              />
              <FieldDescription>
                Use a unique name with lowercase letters, numbers, and hyphens.
              </FieldDescription>
            </Field>
            <Field data-disabled={busy || !loaded}>
              <FieldLabel htmlFor={`${id}-endpoint`}>HTTP endpoint</FieldLabel>
              <Input
                id={`${id}-endpoint`}
                type="url"
                value={endpoint}
                onChange={(event) => setEndpoint(event.target.value)}
                placeholder="https://mcp.example.com/mcp"
                maxLength={2048}
                required
                disabled={busy || !loaded}
                autoComplete="off"
              />
              <FieldDescription>
                The MCP endpoint must use HTTP or HTTPS.
              </FieldDescription>
            </Field>
            <Field data-disabled={busy || !loaded || clearToken}>
              <FieldLabel htmlFor={`${id}-token`}>
                Bearer token (optional)
              </FieldLabel>
              <Input
                id={`${id}-token`}
                type="password"
                value={token}
                onChange={(event) => setToken(event.target.value)}
                maxLength={8192}
                disabled={busy || !loaded || clearToken}
                autoComplete="new-password"
              />
              <FieldDescription>
                {baseline?.hasToken
                  ? "A token is saved. Leave this blank to keep it, or enter a replacement."
                  : "Leave blank for a server that does not require authentication."}
              </FieldDescription>
            </Field>
            {baseline?.hasToken && (
              <Field orientation="horizontal" data-disabled={busy || !loaded}>
                <Checkbox
                  id={`${id}-clear-token`}
                  checked={clearToken}
                  onCheckedChange={(checked) => {
                    setClearToken(checked);
                    if (checked) setToken("");
                  }}
                  disabled={busy || !loaded}
                />
                <FieldContent>
                  <FieldLabel htmlFor={`${id}-clear-token`}>
                    Remove saved token
                  </FieldLabel>
                </FieldContent>
              </Field>
            )}
            <Field orientation="horizontal" data-disabled={busy || !loaded}>
              <Checkbox
                id={`${id}-enabled`}
                checked={enabled}
                onCheckedChange={setEnabled}
                disabled={busy || !loaded}
              />
              <FieldContent>
                <FieldLabel htmlFor={`${id}-enabled`}>Enabled</FieldLabel>
                <FieldDescription>
                  Disabling this server stops access for all repositories.
                </FieldDescription>
              </FieldContent>
            </Field>
          </FieldGroup>
        </form>
        <DialogFooter>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => void changeOpen(false)}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            form={id}
            disabled={busy || !loaded || (!!server && !dirty)}
          >
            {busy
              ? loaded
                ? "Saving…"
                : "Loading…"
              : server
                ? "Save server"
                : "Connect server"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
