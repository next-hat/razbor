"use client";

import Link from "next/link.js";
import { useRouter } from "next/navigation.js";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type DragEvent,
  type MouseEvent,
} from "react";
import {
  Check,
  FileText,
  FolderInput,
  Layers,
  Plus,
  Trash2,
  Upload,
} from "lucide-react";

import {
  MAX_SKILL_BUNDLE_BYTES,
  MAX_SKILL_FILE_BYTES,
  MAX_SKILL_FILES,
  skillBundleSchema,
  skillResourcePathSchema,
} from "@razbor/contracts";

import { ConsoleHero } from "@web/components/console-hero.js";
import { Alert, AlertDescription } from "@web/components/ui/alert.js";
import { Button, buttonVariants } from "@web/components/ui/button.js";
import {
  formatSkillBytes as formatBytes,
  parseSavedSkill,
  skillContentBytes as bundleBytes,
  skillContentPaths as orderedPaths,
  SkillContentEditor,
  SkillContentSidebar,
  type SkillContentFiles,
} from "@web/components/skill-content-editor.js";

type ImportMode = "folder" | "files" | "template";

type TextFiles = SkillContentFiles;

type SelectedFile = { path: string; file: File };

const starterFiles: TextFiles = {
  "SKILL.md":
    "---\nname: my-skill\ndescription: Explain when the reviewer should use this skill.\n---\n\n# Review guidance\n\nDescribe the steps and checks to follow.\n",
};

const importMethods = [
  {
    value: "folder" as const,
    title: "Upload folder",
    description: "Keep SKILL.md and nested text resources together.",
    icon: FolderInput,
  },
  {
    value: "files" as const,
    title: "Upload files",
    description: "Select SKILL.md and other Markdown or text files.",
    icon: FileText,
  },
  {
    value: "template" as const,
    title: "Start from template",
    description: "Write review guidance in a starter SKILL.md.",
    icon: Layers,
  },
];

/** Rejects unsafe names before directory traversal can join them into a path. */
function validateEntryName(name: string) {
  if (
    !name ||
    name === "." ||
    name === ".." ||
    /[/\\:]/.test(name) ||
    [...name].some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  )
    throw new Error("Choose a folder with safe relative resource names.");
}

/** Checks each file's declared size and path before reading its content. */
function validateSelectedFile({ path, file }: SelectedFile) {
  if (!skillResourcePathSchema.safeParse(path).success)
    throw new Error(
      "Use safe relative .md or .txt paths, up to 200 UTF-8 bytes, without traversal.",
    );
  if (file.size > MAX_SKILL_FILE_BYTES)
    throw new Error("Each Markdown or text file must fit within 128 KiB.");
}

/** Normalizes one picker folder root while refusing mixed roots or flat folder input. */
function pickerFiles(selected: FileList, mode: "folder" | "files") {
  if (selected.length > MAX_SKILL_FILES)
    throw new Error("The selection exceeds the skill resource limit.");
  const files = Array.from(selected);
  let root: string | undefined;
  let bytes = 0;
  const seen = new Set<string>();
  return files.map((file) => {
    let path = file.name;
    if (mode === "folder") {
      const parts = file.webkitRelativePath.split("/");
      if (parts.length < 2)
        throw new Error(
          "This browser could not read a folder. Choose Upload files instead.",
        );
      validateEntryName(parts[0]);
      root ??= parts[0];
      if (root !== parts[0])
        throw new Error("Choose one skill folder at a time.");
      path = parts.slice(1).join("/");
    } else if (file.webkitRelativePath) {
      throw new Error("Use Upload folder to preserve nested resource paths.");
    }
    const entry = { path, file };
    validateSelectedFile(entry);
    if (seen.has(path))
      throw new Error("The selected files contain duplicate resource paths.");
    seen.add(path);
    bytes += file.size;
    if (bytes > MAX_SKILL_BUNDLE_BYTES)
      throw new Error("A skill can contain at most 1 MiB of text content.");
    return entry;
  });
}

/** Reads every directory batch and bounds traversal before loading file contents. */
async function droppedFiles(
  entries: FileSystemEntry[],
  mode: "folder" | "files",
) {
  if (mode === "folder") {
    if (entries.length !== 1 || !entries[0].isDirectory)
      throw new Error("Drop one folder containing a root SKILL.md.");
  } else if (entries.some((entry) => !entry.isFile)) {
    throw new Error(
      "Drop files here, or choose Upload folder to keep nested resources.",
    );
  }
  const files: SelectedFile[] = [];
  const paths = new Set<string>();
  // Include the managed catalog and skill root in the traversal budget.
  let resources = mode === "folder" ? 1 : 2;
  let bytes = 0;

  /** Traverses a dropped entry using its relative name, with a bounded depth and budget. */
  async function visit(entry: FileSystemEntry, parent: string, depth: number) {
    resources++;
    if (resources > MAX_SKILL_FILES || depth > 100)
      throw new Error("The folder exceeds the skill resource or depth limit.");
    validateEntryName(entry.name);
    const path = parent ? `${parent}/${entry.name}` : entry.name;
    if (entry.isFile) {
      const file = await new Promise<File>((resolve, reject) => {
        (entry as FileSystemFileEntry).file(resolve, reject);
      });
      const selected = { path, file };
      validateSelectedFile(selected);
      if (paths.has(path))
        throw new Error("The dropped files contain duplicate resource paths.");
      paths.add(path);
      bytes += file.size;
      if (bytes > MAX_SKILL_BUNDLE_BYTES)
        throw new Error("A skill can contain at most 1 MiB of text content.");
      files.push(selected);
      return;
    }
    if (!entry.isDirectory)
      throw new Error(
        "This drop contains an unsupported entry. Use the picker.",
      );
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => {
        reader.readEntries(resolve, reject);
      });
      if (!batch.length) break;
      if (batch.length > MAX_SKILL_FILES - resources)
        throw new Error("The folder exceeds the skill resource limit.");
      for (const child of batch)
        await visit(child, depth === 0 ? "" : path, depth + 1);
    }
  }

  for (const entry of entries) await visit(entry, "", 0);
  return files;
}

/** Decodes bounded files as strict UTF-8 and validates the complete bundle atomically. */
async function decodeFiles(selected: SelectedFile[]) {
  if (!selected.length)
    throw new Error("Choose a folder or files with SKILL.md.");
  const files: TextFiles = Object.create(null) as TextFiles;
  for (const entry of selected) {
    validateSelectedFile(entry);
    if (Object.hasOwn(files, entry.path))
      throw new Error("The selected files contain duplicate resource paths.");
    try {
      files[entry.path] = new TextDecoder("utf-8", { fatal: true }).decode(
        await entry.file.arrayBuffer(),
      );
    } catch (error) {
      if (error instanceof TypeError)
        throw new Error("Every skill file must contain valid UTF-8 text.", {
          cause: error,
        });
      throw error;
    }
  }
  const parsed = skillBundleSchema.safeParse({ files });
  if (!parsed.success)
    throw new Error(
      "Include a root SKILL.md and readable text resources within the 128 KiB file, 1 MiB bundle, and 2,000 resource limits. Files cannot also be directories.",
    );
  return parsed.data.files;
}

/** Creates a skill from independent local upload drafts or an editable starter bundle. */
export function SkillCreatePage({
  initialMode = "template",
}: Readonly<{ initialMode?: "files" | "template" }>) {
  const id = useId();
  const router = useRouter();
  const picker = useRef<HTMLInputElement>(null);
  const operation = useRef(0);
  const hasUnsaved = useRef(false);
  const hasSaved = useRef(false);
  const [mode, setMode] = useState<ImportMode>(initialMode);
  const [template, setTemplate] = useState<TextFiles>(starterFiles);
  const [uploads, setUploads] = useState<{
    folder: TextFiles | null;
    files: TextFiles | null;
  }>({ folder: null, files: null });
  const [busy, setBusy] = useState<"reading" | "saving" | null>(null);
  const [error, setError] = useState("");
  const [dragActive, setDragActive] = useState(false);
  const files = mode === "template" ? template : (uploads[mode] ?? {});
  const paths = orderedPaths(files);
  const bytes = bundleBytes(files);
  const dirty =
    JSON.stringify(template) !== JSON.stringify(starterFiles) ||
    uploads.folder !== null ||
    uploads.files !== null;
  hasUnsaved.current = dirty && !hasSaved.current;

  useEffect(() => {
    /** Lets the browser warn before leaving local content that has not been saved. */
    function beforeUnload(event: BeforeUnloadEvent) {
      if (!hasUnsaved.current) return;
      event.preventDefault();
      event.returnValue = "";
    }
    window.addEventListener("beforeunload", beforeUnload);
    return () => {
      operation.current++;
      window.removeEventListener("beforeunload", beforeUnload);
    };
  }, []);

  /** Preserves each method's draft when changing the visible form. */
  function changeMode(value: ImportMode) {
    if (busy) return;
    setMode(value);
    setError("");
    setDragActive(false);
  }

  /** Replaces one upload draft only after all selected files have validated. */
  async function importSelection(
    chosen: Promise<SelectedFile[]> | SelectedFile[],
    target: "folder" | "files",
  ) {
    if (busy) return;
    const token = ++operation.current;
    setBusy("reading");
    setError("");
    try {
      const imported = await decodeFiles(await chosen);
      if (token !== operation.current) return;
      setUploads((current) => ({ ...current, [target]: imported }));
    } catch (error) {
      if (token !== operation.current) return;
      setError(
        error instanceof Error ? error.message : "Unable to read files.",
      );
    } finally {
      if (token === operation.current) setBusy(null);
    }
  }

  /** Uses the picker selection without dropping folder paths or replacing valid content on failure. */
  function chooseFiles(selected: FileList | null) {
    if (!selected?.length || busy || mode === "template") return;
    try {
      void importSelection(pickerFiles(selected, mode), mode);
    } catch (error) {
      setError(
        error instanceof Error ? error.message : "Unable to read files.",
      );
    }
  }

  /** Captures filesystem entries during the drop event before asynchronous traversal starts. */
  function dropFiles(event: DragEvent<HTMLElement>) {
    event.preventDefault();
    setDragActive(false);
    if (busy || mode === "template") return;
    if (event.dataTransfer.items.length > MAX_SKILL_FILES) {
      setError("The selection exceeds the skill resource limit.");
      return;
    }
    const items = Array.from(event.dataTransfer.items).filter(
      (item) => item.kind === "file",
    );
    const entries = items.map((item) => item.webkitGetAsEntry?.());
    if (!entries.length || entries.some((entry) => !entry)) {
      setError(
        "This browser cannot read this drop safely. Click the upload area to use the file picker.",
      );
      return;
    }
    void importSelection(
      droppedFiles(entries as FileSystemEntry[], mode),
      mode,
    );
  }

  /** Removes an optional uploaded resource while retaining the root entry point. */
  function removeResource(path: string) {
    if (busy || path === "SKILL.md" || mode === "template") return;
    const remaining = Object.fromEntries(
      Object.entries(files).filter(([resource]) => resource !== path),
    );
    setUploads((current) => ({ ...current, [mode]: remaining }));
    setError("");
  }

  /** Confirms explicit cancellation when any method contains unsaved local changes. */
  function cancel(event: MouseEvent<HTMLAnchorElement>) {
    if (
      busy ||
      (dirty && !window.confirm("Discard your unsaved skill changes?"))
    )
      event.preventDefault();
    else hasUnsaved.current = false;
  }

  /** Saves a validated bundle and navigates only after a complete successful response. */
  async function save() {
    if (busy) return;
    const parsed = skillBundleSchema.safeParse({ files });
    if (!parsed.success) {
      setError(
        "Include SKILL.md and safe readable .md or .txt resources, up to 128 KiB each and 1 MiB total.",
      );
      return;
    }
    const token = ++operation.current;
    setBusy("saving");
    setError("");
    let saved = false;
    try {
      const response = await fetch("/api/skills", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsed.data),
      });
      const result: unknown = await response.json();
      if (!response.ok) {
        const message =
          result && typeof result === "object" && "error" in result
            ? result.error
            : undefined;
        throw new Error(
          typeof message === "string" ? message : "Unable to create skill.",
        );
      }
      if (!parseSavedSkill(result))
        throw new Error(
          "The server did not return a complete skill. Check the Skills page before trying again.",
        );
      if (token !== operation.current) return;
      saved = true;
      hasSaved.current = true;
      hasUnsaved.current = false;
      router.push("/skills");
      router.refresh();
    } catch (error) {
      if (token === operation.current)
        setError(
          error instanceof Error ? error.message : "Unable to create skill.",
        );
    } finally {
      if (token === operation.current && !saved) setBusy(null);
    }
  }

  return (
    <main className="console-hero-page skills-create-page flex min-w-0 flex-col">
      <ConsoleHero
        id="skill-create-title"
        eyebrow="New skill"
        title="Create skill"
        description="Create reusable review guidance with SKILL.md and optional text resources."
        breadcrumbs={[{ label: "Skills", href: "/skills" }]}
        breadcrumbLabel="New skill"
      />
      <div className="console-container mt-6 mb-16 grid min-w-0 items-start gap-5 xl:grid-cols-[minmax(0,1fr)_18rem]">
        <form
          className="flex min-w-0 flex-col gap-5"
          aria-busy={busy !== null}
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          {error && (
            <Alert variant="destructive" role="alert">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <section className="rounded-lg border bg-card p-4">
            <div className="mb-4 flex items-start gap-3">
              <span className="overview-metric-icon shrink-0" data-tone="info">
                <Upload aria-hidden="true" className="size-5" />
              </span>
              <div className="min-w-0">
                <h2 className="text-base font-semibold">Import content</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  Choose how to add your skill. Each method keeps its local
                  changes while you stay on this page.
                </p>
              </div>
            </div>
            <fieldset disabled={busy !== null}>
              <legend className="sr-only">Skill content method</legend>
              <div className="grid gap-3 md:grid-cols-3">
                {importMethods.map((method) => {
                  const Icon = method.icon;
                  return (
                    <label
                      key={method.value}
                      className={`relative flex cursor-pointer items-start gap-3 rounded-lg border p-4 transition-colors has-focus-visible:ring-2 has-focus-visible:ring-ring ${mode === method.value ? "border-primary bg-primary/5" : "hover:bg-muted/50"} ${busy ? "cursor-default opacity-60" : ""}`}
                    >
                      <Icon
                        aria-hidden="true"
                        className="mt-0.5 size-5 shrink-0 text-primary"
                      />
                      <div className="min-w-0 flex-1">
                        <span className="text-sm font-medium">
                          {method.title}
                        </span>
                        <p className="mt-1 text-xs leading-5 text-muted-foreground">
                          {method.description}
                        </p>
                      </div>
                      <input
                        type="radio"
                        name={`${id}-mode`}
                        value={method.value}
                        checked={mode === method.value}
                        onChange={() => changeMode(method.value)}
                        className="mt-1 size-4 shrink-0 accent-primary"
                      />
                    </label>
                  );
                })}
              </div>
            </fieldset>
          </section>

          {mode !== "template" && (
            <section className="min-w-0 rounded-lg border bg-card p-4">
              <h2 className="text-base font-semibold">
                {mode === "folder"
                  ? "Upload a skill folder"
                  : "Upload skill files"}
              </h2>
              <p
                id={`${id}-upload-help`}
                className="mt-1 text-sm text-muted-foreground"
              >
                {mode === "folder"
                  ? "Select one folder with a root SKILL.md. Nested resource paths are preserved."
                  : "Select SKILL.md with optional .md or .txt resources. Use Upload folder for nested paths."}
              </p>
              <input
                key={mode}
                ref={(element) => {
                  picker.current = element;
                  if (mode === "folder")
                    element?.setAttribute("webkitdirectory", "");
                }}
                type="file"
                accept=".md,.txt"
                multiple
                disabled={busy !== null}
                aria-label={
                  mode === "folder"
                    ? "Select skill folder"
                    : "Select skill files"
                }
                className="hidden"
                onChange={(event) => {
                  chooseFiles(event.target.files);
                  event.target.value = "";
                }}
              />
              <div
                className="mt-5"
                onDragOver={(event) => {
                  event.preventDefault();
                  if (!busy) setDragActive(true);
                }}
                onDragLeave={(event) => {
                  if (
                    !event.currentTarget.contains(
                      event.relatedTarget as Node | null,
                    )
                  )
                    setDragActive(false);
                }}
                onDrop={dropFiles}
              >
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => picker.current?.click()}
                  aria-describedby={`${id}-upload-help ${id}-limits`}
                  className={`flex min-h-36 w-full flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed px-4 py-5 text-center transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-wait disabled:opacity-60 ${dragActive ? "border-primary bg-primary/10" : "border-border hover:border-primary/60 hover:bg-muted/30"}`}
                >
                  <Upload aria-hidden="true" className="size-6 text-primary" />
                  <span className="text-base font-medium">
                    {busy === "reading"
                      ? "Reading skill content…"
                      : mode === "folder"
                        ? "Drop a skill folder here, or click to browse"
                        : "Drop skill files here, or click to browse"}
                  </span>
                  <span
                    id={`${id}-limits`}
                    className="text-sm text-muted-foreground"
                  >
                    Markdown and text only · 128 KiB per file · 1 MiB total
                  </span>
                  {paths.length > 0 && (
                    <span className="text-xs text-muted-foreground">
                      Choosing again replaces this method’s selection after
                      validation.
                    </span>
                  )}
                </button>
              </div>
              {paths.length > 0 && (
                <div className="mt-5 overflow-hidden rounded-lg border">
                  <div className="flex items-center gap-2 border-b bg-muted/30 px-4 py-3 text-sm font-medium">
                    <Check aria-hidden="true" className="size-4 text-success" />
                    Selected content · {paths.length}{" "}
                    {paths.length === 1 ? "file" : "files"} ·{" "}
                    {formatBytes(bytes)}
                  </div>
                  <ul className="max-h-80 divide-y overflow-y-auto">
                    {paths.map((path) => (
                      <li
                        key={path}
                        className="flex min-w-0 items-center gap-3 px-4 py-3"
                      >
                        <FileText
                          aria-hidden="true"
                          className="size-4 shrink-0 text-muted-foreground"
                        />
                        <span className="min-w-0 flex-1 break-all font-mono text-xs">
                          {path}
                        </span>
                        <span className="shrink-0 text-xs text-muted-foreground">
                          {formatBytes(
                            new TextEncoder().encode(files[path]).byteLength,
                          )}
                        </span>
                        {path !== "SKILL.md" && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            disabled={busy !== null}
                            aria-label={`Remove ${path}`}
                            onClick={() => removeResource(path)}
                          >
                            <Trash2 aria-hidden="true" />
                          </Button>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </section>
          )}
          <div hidden={mode !== "template"}>
            <SkillContentEditor
              files={template}
              disabled={busy !== null}
              onChange={setTemplate}
              onError={setError}
            />
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Link
              href="/skills"
              onClick={cancel}
              aria-disabled={busy !== null}
              className={`${buttonVariants({ variant: "outline" })} aria-disabled:opacity-60`}
            >
              Cancel
            </Link>
            <Button type="submit" disabled={busy !== null || !paths.length}>
              <Plus aria-hidden="true" />
              {busy === "saving" ? "Creating skill…" : "Create skill"}
            </Button>
          </div>
        </form>
        <SkillContentSidebar files={files} />
      </div>
    </main>
  );
}
