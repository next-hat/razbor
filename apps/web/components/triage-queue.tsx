"use client";

import { useId, useState } from "react";

import type { PullRequestView } from "@razbor/database";

import { PullRequestTable } from "@web/components/pull-request-table.js";
import { Button } from "@web/components/ui/button.js";
import { Field, FieldLabel } from "@web/components/ui/field.js";
import { Input } from "@web/components/ui/input.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@web/components/ui/select.js";
import {
  decisionLabels,
  initialQueueFilters,
  orderLabels,
  triageQueue,
  type QueueFilters,
} from "@web/lib/merge-triage.js";

/** Provide a labelled keyboard-accessible selection using the console's standard control. */
function QueueSelect({
  label,
  value,
  items,
  onChange,
}: Readonly<{
  label: string;
  value: string;
  items: Record<string, string>;
  onChange: (next: string) => void;
}>) {
  const id = useId();
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Select
        items={items}
        value={value}
        onValueChange={(next) => {
          if (next !== null) onChange(next);
        }}
      >
        <SelectTrigger id={id} className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent alignItemWithTrigger={false}>
          {Object.entries(items).map(([key, text]) => (
            <SelectItem key={key} value={key}>
              {text}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  );
}

/** Display current decisions with the same filters and priority order on both repository and global pages. */
export function TriageQueue({
  pullRequests,
  global = false,
  preview = false,
}: Readonly<{
  pullRequests: PullRequestView[];
  global?: boolean;
  preview?: boolean;
}>) {
  const [filters, setFilters] = useState(initialQueueFilters);
  const id = useId();
  const selected = triageQueue(pullRequests, filters);
  const changed = Object.entries(filters).some(
    ([key, value]) => initialQueueFilters[key as keyof QueueFilters] !== value,
  );

  /** Replace one filter without changing the other selections. */
  function update(key: keyof QueueFilters, value: string) {
    setFilters((current) => ({ ...current, [key]: value }));
  }

  return (
    <>
      {!preview && (
        <details className="rounded-lg border bg-card p-3">
          <summary className="w-fit cursor-pointer text-sm font-medium">
            Filters and order
            {changed && (
              <span className="ml-2 text-xs text-muted-foreground">
                {selected.length} matching
              </span>
            )}
          </summary>
          <div className="mt-4 grid items-end gap-4 sm:grid-cols-3 xl:grid-cols-4">
            <QueueSelect
              label="Merge decision"
              value={filters.decision}
              items={{
                "": "All decisions",
                ...decisionLabels,
                undecided: "No decision yet",
              }}
              onChange={(v) => update("decision", v)}
            />
            <QueueSelect
              label="Risk"
              value={filters.risk}
              items={{
                "": "All risk levels",
                critical: "Critical",
                high: "High",
                medium: "Medium",
                low: "Low",
              }}
              onChange={(v) => update("risk", v)}
            />
            <Field>
              <FieldLabel htmlFor={id}>Maximum confidence</FieldLabel>
              <Input
                type="number"
                id={id}
                min={0}
                max={100}
                placeholder="Any score"
                value={filters.confidence}
                onChange={(e) => update("confidence", e.target.value)}
              />
            </Field>
            <QueueSelect
              label="Review status"
              value={filters.review}
              items={{
                "": "All statuses",
                unreviewed: "Unreviewed",
                queued: "Queued",
                running: "Running",
                completed: "Completed",
                failed: "Failed",
              }}
              onChange={(v) => update("review", v)}
            />
            {global && (
              <QueueSelect
                label="Repository"
                value={filters.repository}
                items={{
                  "": "All repositories",
                  ...Object.fromEntries(
                    pullRequests.map((pr) => [
                      pr.repositoryId,
                      pr.repositoryName,
                    ]),
                  ),
                }}
                onChange={(v) => update("repository", v)}
              />
            )}
            <QueueSelect
              label="Updated"
              value={filters.updatedDays}
              items={{
                "": "Any time",
                "1": "Last 24 hours",
                "7": "Last week",
                "30": "Last month",
              }}
              onChange={(v) => update("updatedDays", v)}
            />
            <QueueSelect
              label="Order"
              value={filters.order}
              items={orderLabels}
              onChange={(v) => update("order", v)}
            />
            {changed && (
              <Button
                type="button"
                variant="outline"
                onClick={() => setFilters(initialQueueFilters)}
              >
                Clear filters and order
              </Button>
            )}
          </div>
        </details>
      )}
      {selected.length ? (
        <PullRequestTable
          pullRequests={preview ? selected.slice(0, 5) : selected}
          showState={!preview}
        />
      ) : (
        <p role="status" className="console-card text-sm text-muted-foreground">
          No pull requests match these filters.
        </p>
      )}
    </>
  );
}
