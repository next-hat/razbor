"use client";

import { useEffect, useId, useState } from "react";
import Link from "next/link.js";

import type {
  RepositoryGuidanceView as Guidance,
  SkillView,
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

/** Configures repository-owned guidance and selects installed skills for new reviews. */
export function RepositoryGuidance({
  repositoryId,
  initialGuidance,
  initialSkills,
}: Readonly<{
  repositoryId: string;
  initialGuidance?: Guidance;
  initialSkills?: SkillView[];
}>) {
  const id = useId();
  const [baseline, setBaseline] = useState(initialGuidance);
  const [guidance, setGuidance] = useState(initialGuidance);
  const [skills, setSkills] = useState(initialSkills);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [retry, setRetry] = useState(0);
  const dirty = JSON.stringify(guidance) !== JSON.stringify(baseline);

  useEffect(() => {
    if (initialGuidance && initialSkills) return;
    const controller = new AbortController();
    setError("");
    Promise.all([
      fetch(`/api/repositories/${repositoryId}/guidance`, {
        signal: controller.signal,
      }).then(async (response) => {
        if (!response.ok)
          throw new Error("Unable to load repository guidance.");
        return (await response.json()) as Guidance;
      }),
      fetch("/api/skills", { signal: controller.signal }).then(
        async (response) => {
          if (!response.ok) throw new Error("Unable to load installed skills.");
          return (await response.json()) as SkillView[];
        },
      ),
    ])
      .then(([currentGuidance, currentSkills]) => {
        if (controller.signal.aborted) return;
        setBaseline(currentGuidance);
        setGuidance(currentGuidance);
        setSkills(currentSkills);
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setError("Unable to load review guidance. Please try again.");
      });
    return () => controller.abort();
  }, [repositoryId, initialGuidance, initialSkills, retry]);

  /** Updates a guidance control without changing the last successfully saved baseline. */
  function change(changes: Partial<Omit<Guidance, "configured">>) {
    setGuidance((current) => (current ? { ...current, ...changes } : current));
    setMessage("");
  }

  /** Stores all switches and skill selections for subsequent review snapshots. */
  async function save() {
    if (busy || !guidance) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const response = await fetch(
        `/api/repositories/${repositoryId}/guidance`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            repositoryInstructions: guidance.repositoryInstructions,
            repositorySkills: guidance.repositorySkills,
            skillIds: guidance.skillIds,
            alwaysIncludeSkillIds: guidance.alwaysIncludeSkillIds ?? [],
          }),
        },
      );
      const result = (await response.json()) as Guidance & { error?: string };
      if (!response.ok)
        throw new Error(result.error || "Unable to save review guidance.");
      setBaseline(result);
      setGuidance(result);
      setMessage("Review guidance saved. New reviews will use these settings.");
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "Unable to save review guidance.",
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
            Instructions and skills
          </h2>
          <p className="text-sm leading-relaxed text-muted-foreground">
            Repository instructions and reusable skills for this repository.
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
                  {(!guidance || !skills) && (
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
          {!guidance || !skills ? (
            <output className="block text-sm text-muted-foreground">
              Loading review guidance…
            </output>
          ) : (
            <>
              {!guidance.configured && (
                <p className="text-sm text-muted-foreground">
                  Save these settings to choose the guidance used for new
                  reviews.
                </p>
              )}
              <FieldGroup>
                <FieldSet>
                  <FieldLegend>Repository files</FieldLegend>
                  <FieldDescription>
                    Read guidance from the base commit used by the review.
                    Instructions in nested directories apply to their subtree.
                  </FieldDescription>
                  <Field orientation="horizontal" data-disabled={busy}>
                    <Checkbox
                      id={`${id}-instructions`}
                      checked={guidance.repositoryInstructions}
                      onCheckedChange={(checked) =>
                        change({ repositoryInstructions: checked })
                      }
                      disabled={busy}
                    />
                    <FieldContent className="min-w-0">
                      <FieldLabel htmlFor={`${id}-instructions`}>
                        Read AGENTS.md instructions
                      </FieldLabel>
                      <FieldDescription>
                        Include the root file and applicable nested instruction
                        files.
                      </FieldDescription>
                    </FieldContent>
                  </Field>
                  <Field orientation="horizontal" data-disabled={busy}>
                    <Checkbox
                      id={`${id}-repository-skills`}
                      checked={guidance.repositorySkills}
                      onCheckedChange={(checked) =>
                        change({ repositorySkills: checked })
                      }
                      disabled={busy}
                    />
                    <FieldContent className="min-w-0">
                      <FieldLabel htmlFor={`${id}-repository-skills`}>
                        Discover repository skills
                      </FieldLabel>
                      <FieldDescription>
                        Make skills in .agents/skills/&lt;name&gt;/SKILL.md and
                        their text resources available to the reviewer.
                      </FieldDescription>
                    </FieldContent>
                  </Field>
                </FieldSet>
                <FieldSet>
                  <FieldLegend>Installed skills</FieldLegend>
                  <FieldDescription>
                    Select guidance from your{" "}
                    <Link href="/skills">Skills library</Link>. New reviews keep
                    a snapshot of the selected versions. Always included skills
                    are supplied before the review starts; other selected skills
                    are available for the reviewer to load when relevant.
                  </FieldDescription>
                  {skills.length === 0 ? (
                    <FieldDescription>
                      No skills installed. Create or import a skill in the
                      library to select it here.
                    </FieldDescription>
                  ) : (
                    skills.map((skill) => (
                      <FieldGroup key={skill.id} className="gap-3">
                        <Field orientation="horizontal" data-disabled={busy}>
                          <Checkbox
                            id={`${id}-${skill.id}`}
                            checked={guidance.skillIds.includes(skill.id)}
                            disabled={busy}
                            onCheckedChange={(checked) =>
                              change({
                                skillIds: checked
                                  ? [...guidance.skillIds, skill.id]
                                  : guidance.skillIds.filter(
                                      (skillId) => skillId !== skill.id,
                                    ),
                                alwaysIncludeSkillIds: checked
                                  ? guidance.alwaysIncludeSkillIds
                                  : (
                                      guidance.alwaysIncludeSkillIds ?? []
                                    ).filter((skillId) => skillId !== skill.id),
                              })
                            }
                          />
                          <FieldContent className="min-w-0">
                            <FieldLabel
                              htmlFor={`${id}-${skill.id}`}
                              className="max-w-full flex-wrap break-all"
                            >
                              {skill.name}
                              <Badge variant="secondary">
                                Version {skill.version}
                              </Badge>
                            </FieldLabel>
                            <FieldDescription className="break-words">
                              {skill.description}
                            </FieldDescription>
                          </FieldContent>
                        </Field>
                        <Field
                          orientation="horizontal"
                          className="pl-6"
                          data-disabled={
                            busy || !guidance.skillIds.includes(skill.id)
                          }
                        >
                          <Checkbox
                            id={`${id}-${skill.id}-always`}
                            checked={(
                              guidance.alwaysIncludeSkillIds ?? []
                            ).includes(skill.id)}
                            disabled={
                              busy || !guidance.skillIds.includes(skill.id)
                            }
                            onCheckedChange={(checked) =>
                              change({
                                alwaysIncludeSkillIds: checked
                                  ? [
                                      ...(guidance.alwaysIncludeSkillIds ?? []),
                                      skill.id,
                                    ]
                                  : (
                                      guidance.alwaysIncludeSkillIds ?? []
                                    ).filter((skillId) => skillId !== skill.id),
                              })
                            }
                          />
                          <FieldContent>
                            <FieldLabel htmlFor={`${id}-${skill.id}-always`}>
                              Always include
                              <span className="sr-only"> {skill.name}</span>
                            </FieldLabel>
                          </FieldContent>
                        </Field>
                      </FieldGroup>
                    ))
                  )}
                </FieldSet>
              </FieldGroup>
              <div>
                <Button
                  type="submit"
                  disabled={busy || (guidance.configured && !dirty)}
                >
                  {busy ? "Saving…" : "Save guidance"}
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
