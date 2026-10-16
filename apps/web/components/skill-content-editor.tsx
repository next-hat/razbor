"use client";

import { useId, useState } from "react";
import { BookOpen, Info, Plus, Trash2 } from "lucide-react";

import {
  skillBundleSchema,
  skillResourcePathSchema,
  skillSnapshotSchema,
  type SkillDetail,
} from "@razbor/contracts";

import { Button } from "@web/components/ui/button.js";
import { Input } from "@web/components/ui/input.js";
import { Textarea } from "@web/components/ui/textarea.js";

export type SkillContentFiles = Record<string, string>;

/** Formats bounded content sizes without suggesting that local changes are saved. */
export function formatSkillBytes(bytes: number) {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KiB`;
}

/** Counts the UTF-8 bytes that the bundle validator and server will store. */
export function skillContentBytes(files: SkillContentFiles) {
  return Object.values(files).reduce(
    (sum, content) => sum + new TextEncoder().encode(content).byteLength,
    0,
  );
}

/** Keeps the required entry point first while ordering optional resources by path. */
export function skillContentPaths(files: SkillContentFiles) {
  return Object.keys(files).sort((a, b) =>
    a === "SKILL.md" ? -1 : b === "SKILL.md" ? 1 : a.localeCompare(b),
  );
}

/** Accepts only a complete saved skill, retaining server-derived metadata and timestamps. */
export function parseSavedSkill(value: unknown): SkillDetail | null {
  if (!value || typeof value !== "object") return null;
  const result = value as Record<string, unknown>;
  const parsed = skillSnapshotSchema.safeParse({
    id: result.id,
    name: result.name,
    description: result.description,
    version: result.version,
    files: result.files,
  });
  if (
    !parsed.success ||
    typeof result.createdAt !== "string" ||
    !Number.isFinite(Date.parse(result.createdAt)) ||
    typeof result.updatedAt !== "string" ||
    !Number.isFinite(Date.parse(result.updatedAt))
  )
    return null;
  return {
    ...parsed.data,
    createdAt: result.createdAt,
    updatedAt: result.updatedAt,
  };
}

/** Edits a controlled skill bundle and validates optional resource paths before adding them. */
export function SkillContentEditor({
  files,
  disabled = false,
  onChange,
  onError,
}: Readonly<{
  files: SkillContentFiles;
  disabled?: boolean;
  onChange: (files: SkillContentFiles) => void;
  onError: (message: string) => void;
}>) {
  const id = useId();
  const [selectedPath, setSelectedPath] = useState("SKILL.md");
  const [resourcePath, setResourcePath] = useState("");
  const activePath = Object.hasOwn(files, selectedPath)
    ? selectedPath
    : "SKILL.md";

  /** Adds a bounded empty resource without overwriting an existing file or directory. */
  function addResource() {
    if (disabled) return;
    const path = resourcePath.trim();
    if (
      !skillResourcePathSchema.safeParse(path).success ||
      Object.hasOwn(files, path)
    ) {
      onError(
        "Enter a new relative .md or .txt path, such as references/style.md.",
      );
      return;
    }
    const parsed = skillBundleSchema.safeParse({
      files: { ...files, [path]: "" },
    });
    if (!parsed.success) {
      onError(
        "This resource conflicts with a path or exceeds the bundle limits.",
      );
      return;
    }
    onChange(parsed.data.files);
    setSelectedPath(path);
    setResourcePath("");
    onError("");
  }

  /** Removes an optional resource while retaining SKILL.md as the required entry point. */
  function removeResource() {
    if (disabled || activePath === "SKILL.md") return;
    onChange(
      Object.fromEntries(
        Object.entries(files).filter(([path]) => path !== activePath),
      ),
    );
    setSelectedPath("SKILL.md");
    onError("");
  }

  return (
    <section className="flex min-w-0 flex-col gap-5 rounded-lg border bg-card p-4">
      <div>
        <h2 className="text-base font-semibold">Entry file and resources</h2>
        <p
          id={`${id}-content-help`}
          className="mt-1 text-sm text-muted-foreground"
        >
          Set name and description in SKILL.md’s YAML frontmatter, then write
          your guidance in Markdown.
        </p>
      </div>
      <div className="flex flex-col gap-2">
        <label htmlFor={`${id}-path`} className="text-sm font-medium">
          File to edit
        </label>
        <select
          id={`${id}-path`}
          value={activePath}
          disabled={disabled}
          onChange={(event) => setSelectedPath(event.target.value)}
          className="h-7 w-full rounded-lg border bg-background px-2.5 text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60 pointer-coarse:h-9 sm:max-w-md"
        >
          {skillContentPaths(files).map((path) => (
            <option key={path} value={path}>
              {path}
            </option>
          ))}
        </select>
      </div>
      <div className="flex min-w-0 flex-col gap-2">
        <label
          htmlFor={`${id}-content`}
          className="break-all text-sm font-medium"
        >
          {activePath}
        </label>
        <Textarea
          id={`${id}-content`}
          value={files[activePath] ?? ""}
          disabled={disabled}
          spellCheck={false}
          rows={17}
          aria-describedby={`${id}-content-help`}
          className="min-h-80 resize-y font-mono text-xs leading-6 sm:text-sm"
          onChange={(event) => {
            onChange({ ...files, [activePath]: event.target.value });
            onError("");
          }}
        />
      </div>
      <div className="flex flex-col gap-2 border-t pt-4">
        <label htmlFor={`${id}-resource`} className="text-sm font-medium">
          Add a text resource
        </label>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            id={`${id}-resource`}
            value={resourcePath}
            disabled={disabled}
            placeholder="references/style.md"
            onChange={(event) => setResourcePath(event.target.value)}
            onKeyDown={(event) => {
              // Enter adds the resource instead of submitting the enclosing save form.
              if (event.key === "Enter") {
                event.preventDefault();
                addResource();
              }
            }}
            className="sm:flex-1"
          />
          <Button
            type="button"
            variant="outline"
            onClick={addResource}
            disabled={disabled || !resourcePath.trim()}
          >
            <Plus aria-hidden="true" />
            Add resource
          </Button>
        </div>
        {activePath !== "SKILL.md" && (
          <Button
            type="button"
            variant="ghost"
            className="self-start text-destructive"
            disabled={disabled}
            onClick={removeResource}
          >
            <Trash2 aria-hidden="true" />
            Remove selected resource
          </Button>
        )}
      </div>
    </section>
  );
}

/** Explains skill assignment and summarizes the currently visible unsaved content. */
export function SkillContentSidebar({
  files,
  editing = false,
}: Readonly<{ files: SkillContentFiles; editing?: boolean }>) {
  const paths = skillContentPaths(files);
  return (
    <aside className="flex min-w-0 flex-col gap-5">
      <section className="rounded-lg border bg-card p-4">
        <div className="flex items-center gap-3">
          <Info aria-hidden="true" className="size-5 text-primary" />
          <h2 className="text-base font-semibold">How skills work</h2>
        </div>
        <p className="mt-3 text-sm leading-6 text-muted-foreground">
          Skills are reusable review guidance. After saving, select the skill in
          repository settings to use it for new reviews. Enable Always include
          to supply its instructions before every review starts.
        </p>
        <p className="mt-3 text-sm leading-6 text-muted-foreground">
          The skill name and description come from SKILL.md. The server checks
          that metadata when you save the skill.
        </p>
      </section>
      <section className="rounded-lg border bg-card p-4">
        <div className="flex items-center gap-3">
          <BookOpen aria-hidden="true" className="size-5 text-primary" />
          <h2 className="text-base font-semibold">
            {editing ? "Content summary" : "Local content"}
          </h2>
        </div>
        <dl className="mt-4 flex flex-col gap-3 text-sm">
          <div className="flex justify-between gap-3">
            <dt className="text-muted-foreground">Files</dt>
            <dd>{paths.length}</dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-muted-foreground">Content size</dt>
            <dd>{formatSkillBytes(skillContentBytes(files))}</dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-muted-foreground">Entry point</dt>
            <dd>
              {Object.hasOwn(files, "SKILL.md") ? "SKILL.md" : "Not selected"}
            </dd>
          </div>
        </dl>
        <p className="mt-4 border-t pt-4 text-xs leading-5 text-muted-foreground">
          {editing
            ? "Changes stay in this page until you save. Saved guidance applies to new reviews."
            : "Content stays in this page until you create the skill. Nothing is saved when you switch methods."}
        </p>
      </section>
    </aside>
  );
}
