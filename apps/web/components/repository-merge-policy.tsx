"use client";

import { useId, useState } from "react";

import {
  MAX_POLICY_BYTES,
  mergePolicySchema,
  type MergePolicy,
  type MergePolicySnapshot,
} from "@razbor/contracts";

import { Button } from "@web/components/ui/button.js";
import { Checkbox } from "@web/components/ui/checkbox.js";
import {
  Field,
  FieldDescription,
  FieldLabel,
} from "@web/components/ui/field.js";
import { Input } from "@web/components/ui/input.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@web/components/ui/select.js";
import { Textarea } from "@web/components/ui/textarea.js";

const switches = {
  enabled: "Enable merge automation",
  dryRun: "Dry run · record eligible merges without scheduling",
  requirePassingChecks: "Require passing provider checks",
} as const;

const methods = { squash: "Squash", merge: "Merge commit", rebase: "Rebase" };

type Candidate = MergePolicy["humanReviewers"][number];

/** Keep allowlist identities, responsibilities and optional ownership patterns independently editable. */
function CandidateFields({
  candidate,
  onChange,
  remove,
  disabled,
}: Readonly<{
  candidate: Candidate;
  onChange: (changes: Partial<Candidate>) => void;
  remove: () => void;
  disabled: boolean;
}>) {
  const id = useId();
  return (
    <fieldset
      className="grid gap-3 rounded-lg border p-4 sm:grid-cols-2"
      disabled={disabled}
    >
      <Field>
        <FieldLabel htmlFor={id + "-user"}>Provider username</FieldLabel>
        <Input
          id={id + "-user"}
          required
          value={candidate.username}
          onChange={(e) => onChange({ username: e.target.value })}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor={id + "-name"}>Display label (optional)</FieldLabel>
        <Input
          id={id + "-name"}
          value={candidate.label ?? ""}
          onChange={(e) => onChange({ label: e.target.value || undefined })}
        />
      </Field>
      <Field className="sm:col-span-2">
        <FieldLabel htmlFor={id + "-owns"}>Responsibilities</FieldLabel>
        <Input
          id={id + "-owns"}
          required
          value={candidate.responsibilities}
          onChange={(e) => onChange({ responsibilities: e.target.value })}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor={id + "-paths"}>
          Source paths (one pattern per line)
        </FieldLabel>
        <Textarea
          id={id + "-paths"}
          value={(candidate.pathPatterns ?? []).join("\n")}
          onChange={(e) =>
            onChange({ pathPatterns: e.target.value.split("\n") })
          }
        />
      </Field>
      <Field>
        <FieldLabel htmlFor={id + "-risks"}>
          Risk categories (one per line)
        </FieldLabel>
        <Textarea
          id={id + "-risks"}
          value={(candidate.riskCategories ?? []).join("\n")}
          onChange={(e) =>
            onChange({ riskCategories: e.target.value.split("\n") })
          }
        />
      </Field>
      {!disabled && (
        <Button
          className="w-fit"
          type="button"
          variant="outline"
          onClick={remove}
        >
          Remove reviewer
        </Button>
      )}
    </fieldset>
  );
}

/** Edit the repository-managed Markdown document, deterministic gates and authorized reviewer candidates together. */
export function RepositoryMergePolicy({
  repositoryId,
  initial,
  editable,
}: Readonly<{
  repositoryId: string;
  initial: MergePolicySnapshot;
  editable: boolean;
}>) {
  const id = useId();
  const [saved, setSaved] = useState(initial);
  const [draft, setDraft] = useState(initial.policy);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const disabled = busy || !editable;
  const bytes = new TextEncoder().encode(draft.policyMarkdown).length;

  /** Change the working copy; the version and saved document are advanced only by the server. */
  function change(values: Partial<MergePolicy>) {
    setDraft((current) => ({ ...current, ...values }));
    setError("");
    setNotice("");
  }

  /** Validate the whole document before posting, retaining local edits after a rejected or conflicting save. */
  async function save() {
    if (disabled) return;
    const parsed = mergePolicySchema.safeParse({
      ...draft,
      humanReviewers: draft.humanReviewers.map((person) => ({
        ...person,
        pathPatterns: person.pathPatterns?.filter((x) => x.trim()),
        riskCategories: person.riskCategories?.filter((x) => x.trim()),
      })),
    });
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      setError(`${issue.path.join(".")} — ${issue.message}`);
      return;
    }
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch(
        `/api/repositories/${repositoryId}/merge-policy`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ version: saved.version, policy: parsed.data }),
        },
      );
      const result = (await response.json()) as MergePolicySnapshot & {
        error?: string;
      };
      if (!response.ok)
        throw new Error(result.error ?? "Could not save the merge policy.");
      setSaved(result);
      setDraft(result.policy);
      setNotice("Merge policy saved for subsequent reviews.");
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not save the merge policy.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="console-card flex min-w-0 flex-col gap-6"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <header>
        <h2 className="text-lg font-semibold">Merge Policy</h2>
        <p className="text-sm text-muted-foreground">
          Version {saved.version}
          {editable
            ? " · Changes apply to new reviews."
            : " · Managed in the repository registry file."}
        </p>
      </header>
      <Field>
        <FieldLabel htmlFor={id + "-markdown"}>
          Policy guidance (Markdown)
        </FieldLabel>
        <Textarea
          id={id + "-markdown"}
          className="min-h-48 max-h-96 resize-y font-mono text-sm"
          placeholder="Describe critical components, required verification and when to escalate."
          value={draft.policyMarkdown}
          maxLength={MAX_POLICY_BYTES}
          disabled={disabled}
          onChange={(e) => change({ policyMarkdown: e.target.value })}
        />
        <FieldDescription>
          {bytes.toLocaleString()} / {MAX_POLICY_BYTES.toLocaleString()} bytes ·
          Provider protections and repository restrictions always apply.
        </FieldDescription>
      </Field>
      <fieldset disabled={disabled} className="flex flex-col gap-3">
        <legend className="mb-3 font-semibold">Merge automation</legend>
        {(Object.keys(switches) as Array<keyof typeof switches>).map((key) => (
          <Field key={key} orientation="horizontal">
            <Checkbox
              id={id + key}
              checked={draft[key]}
              disabled={disabled}
              onCheckedChange={(checked) => change({ [key]: checked })}
            />
            <FieldLabel htmlFor={id + key}>{switches[key]}</FieldLabel>
          </Field>
        ))}
        <p className="text-xs text-muted-foreground">
          Only pull requests targeting the default branch can be auto-merged.
        </p>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor={id + "-threshold"}>
              Minimum confidence (0–100)
            </FieldLabel>
            <Input
              id={id + "-threshold"}
              type="number"
              required
              min={0}
              max={100}
              step={1}
              value={
                Number.isNaN(draft.minimumConfidence)
                  ? ""
                  : draft.minimumConfidence
              }
              onChange={(e) =>
                change({ minimumConfidence: e.target.valueAsNumber })
              }
            />
            <FieldDescription>
              An uncalibrated model assessment of merge readiness.
            </FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor={id + "-method"}>Merge method</FieldLabel>
            <Select
              items={methods}
              value={draft.mergeMethod}
              disabled={disabled}
              onValueChange={(method) => {
                if (method) change({ mergeMethod: method });
              }}
            >
              <SelectTrigger id={id + "-method"} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(methods).map(([method, label]) => (
                  <SelectItem key={method} value={method}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FieldDescription>
              The forge must permit this method for the target branch.
            </FieldDescription>
          </Field>
        </div>
      </fieldset>
      <section className="flex flex-col gap-3">
        <div>
          <h3 className="font-semibold">Human reviewers</h3>
          <p className="text-sm text-muted-foreground">
            Only these people can be mentioned when a review is escalated.
          </p>
        </div>
        {draft.humanReviewers.map((person, index) => (
          <CandidateFields
            key={index}
            candidate={person}
            disabled={disabled}
            onChange={(values) =>
              change({
                humanReviewers: draft.humanReviewers.map((p, i) =>
                  i === index ? { ...p, ...values } : p,
                ),
              })
            }
            remove={() =>
              change({
                humanReviewers: draft.humanReviewers.filter(
                  (_, i) => i !== index,
                ),
              })
            }
          />
        ))}
        {editable && (
          <Button
            className="w-fit"
            type="button"
            variant="outline"
            disabled={disabled || draft.humanReviewers.length >= 24}
            onClick={() =>
              change({
                humanReviewers: [
                  ...draft.humanReviewers,
                  { username: "", responsibilities: "" },
                ],
              })
            }
          >
            Add reviewer
          </Button>
        )}
      </section>
      {editable && (
        <div className="flex flex-wrap items-center gap-3 border-t pt-4">
          <Button
            type="submit"
            disabled={
              disabled ||
              bytes > MAX_POLICY_BYTES ||
              JSON.stringify(draft) === JSON.stringify(saved.policy)
            }
          >
            {busy ? "Saving…" : "Save merge policy"}
          </Button>
          {notice && (
            <output className="text-sm text-muted-foreground">{notice}</output>
          )}
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
        </div>
      )}
    </form>
  );
}
