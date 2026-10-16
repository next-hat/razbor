"use client";

import { useId, useState } from "react";

import type { AgentView } from "@razbor/database";

import { AgentForm } from "@web/components/agent-form.js";
import { Alert, AlertDescription } from "@web/components/ui/alert.js";
import {
  Field,
  FieldDescription,
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
import { usePoll } from "@web/lib/use-poll.js";

/**
 * Selects a repository reviewer from refreshed public profiles, preserving an explicit
 * runner-default fallback. Initial profiles seed each mount; subsequent updates
 * come from this selector's polling and inline creation.
 */
export function AgentSelect({
  initialAgents,
  currentAgent,
  value,
  onValueChange,
  disabled,
  allowCreate = false,
  onCreated,
}: Readonly<{
  initialAgents?: AgentView[];
  currentAgent?: Pick<AgentView, "id" | "model" | "endpoint"> | null;
  value: string | null;
  onValueChange: (value: string | null) => void;
  disabled?: boolean;
  allowCreate?: boolean;
  onCreated?: (agent: AgentView) => void;
}>) {
  const id = useId();
  // Parent refreshes must not cancel this selector's independent polling cycle.
  const [initialSnapshot] = useState(initialAgents);
  const {
    data: agents,
    error,
    setData,
  } = usePoll("/api/agents?selection=repository", initialSnapshot);
  const items = [
    { label: "Runner default", value: "" },
    ...(agents ?? (currentAgent ? [currentAgent] : [])).map((agent) => ({
      label: `${agent.model} · ${agent.endpoint}`,
      value: agent.id,
    })),
  ];

  return (
    <Field data-disabled={disabled || !agents}>
      <FieldLabel htmlFor={id}>AI reviewer</FieldLabel>
      <Select
        items={items}
        value={value ?? ""}
        onValueChange={(next) => onValueChange(next || null)}
        disabled={disabled || !agents}
      >
        <SelectTrigger
          id={id}
          className="w-full"
          aria-describedby={`${id}-help`}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent alignItemWithTrigger={false}>
          <SelectGroup>
            {items.map((item) => (
              <SelectItem
                key={item.value}
                value={item.value}
                className="[&>div]:min-w-0 [&>div]:shrink"
              >
                <span className="truncate">{item.label}</span>
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
      <FieldDescription id={`${id}-help`}>
        Choose the model endpoint and credentials used for new reviews. Runner
        default keeps the model configured on the runner for existing setups.
      </FieldDescription>
      {agents?.length === 0 && (
        <FieldDescription>
          No AI reviewers registered.{" "}
          {allowCreate
            ? "Add an agent below to choose its model and credentials here."
            : "Ask an organization admin to add an agent, or use the runner default."}
        </FieldDescription>
      )}
      {allowCreate && (
        <div>
          <AgentForm
            disabled={disabled}
            onSaved={(agent) => {
              setData((current) => [
                ...(current ?? []).filter((item) => item.id !== agent.id),
                agent,
              ]);
              onValueChange(agent.id);
              onCreated?.(agent);
            }}
          />
          <p className="mt-2 text-xs text-muted-foreground">
            The agent is saved immediately and remains available if you cancel
            repository setup.
          </p>
        </div>
      )}
      {error && (
        <Alert variant="destructive">
          <AlertDescription>
            Unable to refresh AI reviewers. Retrying…
          </AlertDescription>
        </Alert>
      )}
    </Field>
  );
}
