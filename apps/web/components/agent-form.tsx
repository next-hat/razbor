"use client";

import { useId, useState } from "react";
import { Plus } from "lucide-react";

import type { AgentView } from "@razbor/database";
import type { ModelProvider, ReasoningEffort } from "@razbor/contracts";

import { Alert, AlertDescription } from "@web/components/ui/alert.js";
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
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@web/components/ui/field.js";
import { Input } from "@web/components/ui/input.js";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@web/components/ui/select.js";

const providers = [
  { value: "openai", label: "OpenAI Responses" },
  { value: "anthropic", label: "Anthropic Claude" },
];

const reasoningEfforts = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
];

/**
 * Creates or edits a reviewer profile without populating the form with its stored API
 * key.
 */
export function AgentForm({
  agent,
  disabled,
  onSaved,
}: Readonly<{
  agent?: AgentView;
  disabled?: boolean;
  onSaved: (agent: AgentView) => void;
}>) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [provider, setProvider] = useState<ModelProvider>(
    agent?.provider ?? "openai",
  );
  const [endpoint, setEndpoint] = useState(agent?.endpoint ?? "");
  const [model, setModel] = useState(agent?.model ?? "");
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>(
    agent?.reasoningEffort ?? "high",
  );
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  /**
   * Resets the form from the selected profile and clears unsaved credentials whenever
   * the dialog changes state.
   */
  function changeOpen(value: boolean) {
    if (busy) return;
    setOpen(value);
    setError("");
    setApiKey("");
    setEndpoint(agent?.endpoint ?? "");
    setProvider(agent?.provider ?? "openai");
    setModel(agent?.model ?? "");
    setReasoningEffort(agent?.reasoningEffort ?? "high");
  }

  /**
   * Persists endpoint, model and applicable reasoning settings, replacing the API key
   * only when a nonempty key was entered.
   */
  async function save() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch(
        agent ? `/api/agents/${agent.id}` : "/api/agents",
        {
          method: agent ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            provider,
            endpoint: endpoint.trim(),
            model: model.trim(),
            ...(provider === "openai" ? { reasoningEffort } : {}),
            ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
          }),
        },
      );
      if (!response.ok) {
        const result = (await response.json()) as { error?: string };
        throw new Error(result.error || "Unable to save agent");
      }
      const result = (await response.json()) as AgentView;
      setApiKey("");
      setOpen(false);
      onSaved(result);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Unable to save agent");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogTrigger
        render={<Button variant={agent ? "outline" : "default"} />}
        disabled={disabled}
        aria-label={agent ? `Edit ${agent.model}` : undefined}
      >
        {!agent && <Plus data-icon="inline-start" />}
        {agent ? "Edit" : "Add agent"}
      </DialogTrigger>
      <DialogContent
        className="max-h-[90dvh] overflow-y-auto sm:max-w-lg"
        showCloseButton={!busy}
      >
        <DialogHeader>
          <DialogTitle>{agent ? "Edit agent" : "Add agent"}</DialogTitle>
          <DialogDescription>
            {agent
              ? "Update this model's review settings and credentials."
              : "Register a model endpoint, review settings and API key."}
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            event.stopPropagation();
            void save();
          }}
          aria-busy={busy}
        >
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <FieldGroup>
            <Field data-disabled={busy}>
              <FieldLabel htmlFor={`${id}-provider`}>Provider</FieldLabel>
              <Select
                items={providers}
                value={provider}
                onValueChange={(value) => {
                  if (value === "openai" || value === "anthropic")
                    setProvider(value);
                }}
                disabled={busy}
              >
                <SelectTrigger id={`${id}-provider`} className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {providers.map((item) => (
                      <SelectItem key={item.value} value={item.value}>
                        {item.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
              {provider === "anthropic" && (
                <FieldDescription>
                  Claude uses its native reasoning behavior. The OpenAI
                  reasoning effort setting does not apply.
                </FieldDescription>
              )}
            </Field>
            <Field data-disabled={busy}>
              <FieldLabel htmlFor={`${id}-endpoint`}>Endpoint URL</FieldLabel>
              <Input
                id={`${id}-endpoint`}
                type="url"
                placeholder={
                  provider === "anthropic"
                    ? "https://api.anthropic.com/v1/messages"
                    : "https://api.openai.com/v1/responses"
                }
                value={endpoint}
                onChange={(event) => setEndpoint(event.target.value)}
                aria-describedby={`${id}-endpoint-help`}
                autoComplete="off"
                spellCheck={false}
                maxLength={2048}
                required
                disabled={busy}
              />
              <FieldDescription id={`${id}-endpoint-help`}>
                {provider === "anthropic"
                  ? "The complete Anthropic Messages API URL, including /messages."
                  : "The complete OpenAI Responses API URL, including /responses."}
                {agent &&
                  " After changing this URL or provider, submit queued or retried reviews again. Reviews already running keep their current settings."}
              </FieldDescription>
            </Field>
            <Field data-disabled={busy}>
              <FieldLabel htmlFor={`${id}-model`}>Model</FieldLabel>
              <Input
                id={`${id}-model`}
                placeholder="Model identifier"
                value={model}
                onChange={(event) => setModel(event.target.value)}
                autoComplete="off"
                spellCheck={false}
                maxLength={256}
                required
                disabled={busy}
              />
            </Field>
            {provider === "openai" && (
              <Field data-disabled={busy}>
                <FieldLabel htmlFor={`${id}-reasoning`}>
                  Reasoning effort
                </FieldLabel>
                <Select
                  items={reasoningEfforts}
                  value={reasoningEffort}
                  onValueChange={(value) => {
                    if (
                      value === "low" ||
                      value === "medium" ||
                      value === "high"
                    )
                      setReasoningEffort(value);
                  }}
                  disabled={busy}
                >
                  <SelectTrigger
                    id={`${id}-reasoning`}
                    className="w-full"
                    aria-describedby={`${id}-reasoning-help`}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {reasoningEfforts.map((item) => (
                        <SelectItem key={item.value} value={item.value}>
                          {item.label}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
                <FieldDescription id={`${id}-reasoning-help`}>
                  High is the default. Choose how much reasoning supported
                  OpenAI-compatible models apply to each review.
                </FieldDescription>
              </Field>
            )}
            <Field data-disabled={busy}>
              <FieldLabel htmlFor={`${id}-key`}>API key</FieldLabel>
              <Input
                id={`${id}-key`}
                type="password"
                placeholder={
                  agent
                    ? "Leave blank to keep the current key"
                    : "Paste your API key"
                }
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                aria-describedby={`${id}-key-help`}
                autoComplete="new-password"
                spellCheck={false}
                maxLength={8192}
                required={!agent}
                disabled={busy}
              />
              <FieldDescription id={`${id}-key-help`}>
                {agent
                  ? "Enter a new key to replace it. Saved keys are never displayed."
                  : "Saved keys are never displayed."}
              </FieldDescription>
            </Field>
          </FieldGroup>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => changeOpen(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={
                busy ||
                !endpoint.trim() ||
                !model.trim() ||
                (!agent && !apiKey.trim())
              }
            >
              {busy ? "Saving…" : agent ? "Save changes" : "Add agent"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
