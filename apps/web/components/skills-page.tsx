"use client";

import Link from "next/link.js";
import { useEffect, useState } from "react";
import {
  BookOpen,
  Clock3,
  FilePenLine,
  FolderInput,
  Info,
  Plus,
  Search,
  type LucideIcon,
} from "lucide-react";

import type { SkillView } from "@razbor/contracts";

import { ConsoleHero } from "@web/components/console-hero.js";
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
import { formatUtc } from "@web/lib/date.js";

/** Finds the latest valid catalog save timestamp, omitting unavailable or invalid dates. */
function latestSkillUpdate(skills: SkillView[] | undefined) {
  let latestTimestamp = Number.NEGATIVE_INFINITY;
  for (const skill of skills ?? []) {
    const timestamp = Date.parse(skill.updatedAt);
    if (Number.isFinite(timestamp) && timestamp > latestTimestamp)
      latestTimestamp = timestamp;
  }
  return Number.isFinite(latestTimestamp)
    ? new Date(latestTimestamp).toISOString()
    : undefined;
}

/** Shows a saved catalog count or timestamp with its explanation aligned to the bottom of the card. */
function SkillSummaryCard({
  label,
  value,
  detail,
  icon: Icon,
  tone,
  valueTitle,
}: Readonly<{
  label: string;
  value: number | string | undefined;
  detail: string;
  icon: LucideIcon;
  tone: "success" | "info" | "findings" | "tokens";
  valueTitle?: string;
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
          className="mt-1 break-words text-2xl font-semibold tracking-tight tabular-nums"
          title={valueTitle}
        >
          {typeof value === "number"
            ? value.toLocaleString("en-US")
            : (value ?? "—")}
        </p>
        <p className="mt-auto pt-1 text-xs leading-relaxed text-muted-foreground">
          {detail}
        </p>
      </div>
    </div>
  );
}

/** Confirms removal and retains repository-assignment conflicts for the operator. */
function DeleteSkill({
  skill,
  onDeleted,
}: Readonly<{ skill: SkillView; onDeleted: (id: string) => void }>) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  /** Keeps the confirmation visible during deletion and clears previous failures. */
  function changeOpen(value: boolean) {
    if (busy) return;
    setOpen(value);
    setError("");
  }

  /** Removes the row only after storage accepts the deletion. */
  async function remove() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/skills/${skill.id}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
      });
      if (!response.ok) {
        const result = (await response.json()) as { error?: string };
        throw new Error(result.error || "Unable to delete skill.");
      }
      setOpen(false);
      onDeleted(skill.id);
    } catch (error) {
      setError(
        error instanceof Error ? error.message : "Unable to delete skill.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogTrigger
        render={<Button variant="ghost" />}
        aria-label={`Delete ${skill.name}`}
      >
        Delete
      </DialogTrigger>
      <DialogContent showCloseButton={!busy}>
        <DialogHeader>
          <DialogTitle>Delete skill?</DialogTitle>
          <DialogDescription>
            Remove {skill.name} and its text resources. Deselect it in
            repository settings first. Reviews already queued keep their saved
            version.
          </DialogDescription>
        </DialogHeader>
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
            {busy ? "Deleting…" : "Delete skill"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Lists installed skills, links to their content pages, and reflects successful deletions. */
export function SkillsPage({
  initialData,
}: Readonly<{ initialData?: SkillView[] }>) {
  const [skills, setSkills] = useState(initialData);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [notice, setNotice] = useState("");
  const [search, setSearch] = useState("");
  const revisedSkills = skills?.filter((skill) => skill.version > 1).length;
  const latestUpdatedAt = latestSkillUpdate(skills);
  const query = search.trim().toLowerCase();
  const visibleSkills = skills?.filter((skill) =>
    `${skill.name} ${skill.description}`.toLowerCase().includes(query),
  );

  useEffect(() => {
    if (initialData) return;
    const controller = new AbortController();
    setError("");
    void fetch("/api/skills", { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("Unable to load skills.");
        const result = (await response.json()) as SkillView[];
        if (!controller.signal.aborted) setSkills(result);
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setError("Unable to load skills. Please try again.");
      });
    return () => controller.abort();
  }, [initialData, retry]);

  /** Announces removal after deleting the skill from the local catalog. */
  function deleted(id: string) {
    setSkills((current) => current?.filter((item) => item.id !== id));
    setNotice("Skill deleted.");
  }

  return (
    <main className="console-hero-page skills-page flex min-w-0 flex-col">
      <ConsoleHero
        id="skills-title"
        eyebrow="Reusable review guidance"
        title="Skills"
        description="Reusable review guidance for your repositories."
      >
        <span className="console-hero-status">
          <BookOpen aria-hidden="true" className="size-3.5 shrink-0" />
          <span className="tabular-nums">
            {skills?.length ?? "—"} installed
          </span>
        </span>
      </ConsoleHero>
      <div className="console-container mt-6 mb-16 flex min-w-0 flex-col gap-5">
        <section
          aria-label="Skill totals"
          className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3"
        >
          <SkillSummaryCard
            label="Total skills"
            value={skills?.length}
            detail="Installed review guidance"
            icon={BookOpen}
            tone="findings"
          />
          <SkillSummaryCard
            label="Revised skills"
            value={revisedSkills}
            detail="Saved more than once"
            icon={FilePenLine}
            tone="info"
          />
          <div className="sm:col-span-2 lg:col-span-1">
            <SkillSummaryCard
              label="Last updated"
              value={
                latestUpdatedAt
                  ? `${latestUpdatedAt.slice(11, 16)} UTC`
                  : undefined
              }
              detail={
                latestUpdatedAt
                  ? `${latestUpdatedAt.slice(0, 10)} · Latest saved skill`
                  : "Saved timestamp unavailable"
              }
              valueTitle={
                latestUpdatedAt ? formatUtc(latestUpdatedAt) : undefined
              }
              icon={Clock3}
              tone="tokens"
            />
          </div>
        </section>
        {notice && (
          <p role="status" className="text-sm">
            {notice}
          </p>
        )}
        <div className="skills-toolbar flex flex-wrap items-center justify-between gap-4">
          <Field className="w-full min-w-0 sm:max-w-md">
            <FieldLabel htmlFor="skill-search" className="sr-only">
              Search skills
            </FieldLabel>
            <div className="relative">
              <Search
                aria-hidden="true"
                className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
              />
              <Input
                id="skill-search"
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search name or description…"
                disabled={!skills}
                className="pl-9"
              />
            </div>
          </Field>
          <div className="skills-actions flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              nativeButton={false}
              render={<Link href="/skills/new?mode=files" />}
            >
              <FolderInput data-icon="inline-start" />
              Import skill
            </Button>
            <Button
              nativeButton={false}
              render={<Link href="/skills/new?mode=template" />}
            >
              <Plus data-icon="inline-start" />
              Create skill
            </Button>
          </div>
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
        ) : !skills ? (
          <div role="status">
            <span className="sr-only">Loading skills…</span>
            <Skeleton className="h-64 w-full" />
          </div>
        ) : !visibleSkills?.length ? (
          <Empty className="border bg-card py-12">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                {query ? <Search /> : <BookOpen />}
              </EmptyMedia>
              <EmptyTitle>
                {query ? "No matching skills" : "No skills installed"}
              </EmptyTitle>
              <EmptyDescription>
                {query
                  ? "Try another skill name or description."
                  : "Create review guidance or import a skill folder to make it available across your repositories."}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="skills-table overflow-hidden rounded-lg border bg-card">
            <Table aria-label="Installed skills">
              <TableHeader>
                <TableRow>
                  <TableHead className="skills-identity-cell">Skill</TableHead>
                  <TableHead className="skills-status-cell">Status</TableHead>
                  <TableHead className="skills-version-cell">Version</TableHead>
                  <TableHead className="skills-updated-cell">Updated</TableHead>
                  <TableHead className="skills-actions-cell">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visibleSkills.map((skill) => (
                  <TableRow key={skill.id}>
                    <TableCell
                      className="skills-identity-cell"
                      data-label="Skill"
                    >
                      <div className="flex min-w-0 items-start gap-3">
                        <span className="flex size-10 shrink-0 items-center justify-center rounded-lg border bg-muted/40 text-muted-foreground">
                          <BookOpen aria-hidden="true" className="size-5" />
                        </span>
                        <div className="flex min-w-0 flex-col gap-1">
                          <Link
                            href={`/skills/${skill.id}`}
                            className="rounded-sm break-all font-semibold hover:underline focus-visible:outline-2 focus-visible:outline-ring"
                          >
                            {skill.name}
                          </Link>
                          <span className="break-words text-xs leading-relaxed text-muted-foreground">
                            {skill.description}
                          </span>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell
                      className="skills-status-cell"
                      data-label="Status"
                    >
                      <Badge
                        variant="success"
                        className="h-auto min-h-5 max-w-full whitespace-normal"
                      >
                        Installed
                      </Badge>
                    </TableCell>
                    <TableCell
                      className="skills-version-cell"
                      data-label="Version"
                    >
                      <Badge
                        variant="secondary"
                        className="h-auto min-h-5 max-w-full whitespace-normal"
                      >
                        v{skill.version}
                      </Badge>
                    </TableCell>
                    <TableCell
                      className="skills-updated-cell"
                      data-label="Updated"
                    >
                      <time
                        className="text-xs text-muted-foreground"
                        dateTime={skill.updatedAt}
                      >
                        {formatUtc(skill.updatedAt)}
                      </time>
                    </TableCell>
                    <TableCell
                      className="skills-actions-cell"
                      data-label="Actions"
                    >
                      <div className="flex flex-wrap items-center justify-end gap-2">
                        <Button
                          variant="outline"
                          nativeButton={false}
                          render={<Link href={`/skills/${skill.id}`} />}
                          aria-label={`Open ${skill.name}`}
                        >
                          Open
                        </Button>
                        <DeleteSkill skill={skill} onDeleted={deleted} />
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
        <section
          aria-labelledby="about-skills"
          className="flex items-start gap-3 rounded-lg border bg-card p-5"
        >
          <Info
            aria-hidden="true"
            className="mt-0.5 size-5 shrink-0 text-primary"
          />
          <div>
            <h2 id="about-skills" className="text-lg font-semibold">
              About skills
            </h2>
            <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
              Select installed skills in repository settings to use their review
              guidance. Each bundle starts with SKILL.md and can include
              Markdown or text resources. Reviews already queued keep their
              saved version.
            </p>
          </div>
        </section>
      </div>
    </main>
  );
}
