"use client";

import Link from "next/link.js";
import { useRouter } from "next/navigation.js";
import { useEffect, useRef, useState, type MouseEvent } from "react";
import { BookOpen, RefreshCw, Save, Undo2 } from "lucide-react";

import { skillBundleSchema, type SkillDetail } from "@razbor/contracts";

import { ConsoleHero } from "@web/components/console-hero.js";
import {
  parseSavedSkill,
  SkillContentEditor,
  SkillContentSidebar,
  type SkillContentFiles,
} from "@web/components/skill-content-editor.js";
import { Alert, AlertDescription } from "@web/components/ui/alert.js";
import { Button, buttonVariants } from "@web/components/ui/button.js";

/** Compares resource contents without treating different object insertion orders as edits. */
function sameContent(a: SkillContentFiles, b: SkillContentFiles) {
  return (
    Object.keys(a).length === Object.keys(b).length &&
    Object.entries(a).every(
      ([path, content]) => Object.hasOwn(b, path) && b[path] === content,
    )
  );
}

/** Formats a validated server timestamp consistently during server rendering and hydration. */
function savedTime(value: string) {
  return `${new Date(value).toISOString().slice(0, 19).replace("T", " ")} UTC`;
}

/** Reads an API-safe error message without assuming a successful response shape. */
function responseError(value: unknown, fallback: string) {
  return value &&
    typeof value === "object" &&
    "error" in value &&
    typeof value.error === "string"
    ? value.error
    : fallback;
}

/** Presents the saved bundle in the shared content editor and saves explicit changes in place. */
export function SkillDetailPage({
  skillId,
  initialData,
}: Readonly<{ skillId: string; initialData?: SkillDetail }>) {
  const router = useRouter();
  const operation = useRef(0);
  const request = useRef<AbortController | null>(null);
  const hasUnsaved = useRef(false);
  const [skill, setSkill] = useState(initialData);
  const [files, setFiles] = useState<SkillContentFiles>(
    initialData?.files ?? {},
  );
  const [baseline, setBaseline] = useState<SkillContentFiles>(
    initialData?.files ?? {},
  );
  const [busy, setBusy] = useState<"loading" | "saving" | null>(null);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState(
    initialData
      ? ""
      : "Skill storage is unavailable. Try loading this skill again.",
  );
  const [notice, setNotice] = useState("");
  const [editorRevision, setEditorRevision] = useState(0);
  const dirty = !sameContent(files, baseline);
  hasUnsaved.current = dirty;

  useEffect(() => {
    /** Warns on browser unload while an explicit edit has not been saved or discarded. */
    function beforeUnload(event: BeforeUnloadEvent) {
      if (!hasUnsaved.current) return;
      event.preventDefault();
      event.returnValue = "";
    }
    window.addEventListener("beforeunload", beforeUnload);
    return () => {
      operation.current++;
      request.current?.abort();
      window.removeEventListener("beforeunload", beforeUnload);
    };
  }, []);

  /** Recovers an unavailable server read without overwriting any loaded editable draft. */
  async function load() {
    if (busy || request.current || skill || missing) return;
    const token = ++operation.current;
    const controller = new AbortController();
    request.current = controller;
    setBusy("loading");
    setError("");
    try {
      const response = await fetch(`/api/skills/${skillId}`, {
        cache: "no-store",
        signal: controller.signal,
      });
      if (token !== operation.current) return;
      if (response.status === 404) {
        setMissing(true);
        return;
      }
      const result: unknown = await response.json();
      if (!response.ok)
        throw new Error(
          responseError(result, "Unable to load this skill. Try again."),
        );
      const loaded = parseSavedSkill(result);
      if (!loaded || loaded.id !== skillId)
        throw new Error(
          "The server did not return this skill’s complete content. Try again.",
        );
      if (token !== operation.current) return;
      setSkill(loaded);
      setFiles(loaded.files);
      setBaseline(loaded.files);
    } catch (error) {
      if (token === operation.current && !controller.signal.aborted)
        setError(
          error instanceof Error ? error.message : "Unable to load this skill.",
        );
    } finally {
      if (token === operation.current) {
        request.current = null;
        setBusy(null);
      }
    }
  }

  /** Adopts editor changes locally, leaving saved metadata unchanged until a successful save. */
  function changeContent(value: SkillContentFiles) {
    if (busy) return;
    setFiles(value);
    setNotice("");
  }

  /** Resets local content and editor controls to the last complete saved bundle. */
  function discard() {
    if (
      busy ||
      !dirty ||
      !window.confirm("Discard your unsaved skill changes?")
    )
      return;
    setFiles(baseline);
    setError("");
    setNotice("");
    setEditorRevision((current) => current + 1);
    hasUnsaved.current = false;
  }

  /** Confirms explicit navigation back to the catalog when the bundle has local edits. */
  function leave(event: MouseEvent<HTMLAnchorElement>) {
    if (
      busy ||
      (dirty && !window.confirm("Discard your unsaved skill changes?"))
    )
      event.preventDefault();
    else hasUnsaved.current = false;
  }

  /** Saves only changed content and adopts metadata, version, and baseline from the validated server response. */
  async function save() {
    if (busy || request.current || !skill || !dirty) return;
    const parsed = skillBundleSchema.safeParse({ files });
    if (!parsed.success) {
      setError(
        "Include SKILL.md and safe readable .md or .txt resources, up to 128 KiB each and 1 MiB total.",
      );
      return;
    }
    const token = ++operation.current;
    const controller = new AbortController();
    request.current = controller;
    setBusy("saving");
    setError("");
    setNotice("");
    try {
      const response = await fetch(`/api/skills/${skillId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsed.data),
        signal: controller.signal,
      });
      const result: unknown = await response.json();
      if (!response.ok)
        throw new Error(
          responseError(result, "Unable to save this skill. Try again."),
        );
      const saved = parseSavedSkill(result);
      if (!saved || saved.id !== skillId)
        throw new Error(
          "The server did not return a complete updated skill. Your local changes are still here.",
        );
      if (token !== operation.current) return;
      setSkill(saved);
      setFiles(saved.files);
      setBaseline(saved.files);
      hasUnsaved.current = false;
      setNotice("Changes saved.");
      router.refresh();
    } catch (error) {
      if (token === operation.current && !controller.signal.aborted)
        setError(
          error instanceof Error ? error.message : "Unable to save this skill.",
        );
    } finally {
      if (token === operation.current) {
        request.current = null;
        setBusy(null);
      }
    }
  }

  return (
    <main className="console-hero-page skill-detail-page flex min-w-0 flex-col">
      <ConsoleHero
        id="skill-detail-title"
        eyebrow="Review guidance"
        title="Skill"
        description="Review and edit this skill’s guidance and text resources."
        breadcrumbs={[{ label: "Skills", href: "/skills" }]}
        breadcrumbLabel="Skill"
      >
        {skill && (
          <span className="console-hero-status min-w-0 max-w-full">
            <BookOpen aria-hidden="true" className="size-4 shrink-0" />
            <span className="min-w-0 truncate" title={skill.name}>
              {skill.name}
            </span>
          </span>
        )}
      </ConsoleHero>
      {skill ? (
        <div className="console-container mt-6 mb-16 grid min-w-0 items-start gap-5 xl:grid-cols-[minmax(0,1fr)_18rem]">
          <form
            className="flex min-w-0 flex-col gap-5"
            aria-busy={busy !== null}
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <section className="rounded-lg border bg-card p-4">
              <div className="flex flex-wrap items-center gap-3">
                <h2 className="min-w-0 break-all text-lg font-semibold">
                  {skill.name}
                </h2>
                <span className="rounded-full bg-muted px-2.5 py-1 text-xs text-muted-foreground">
                  Version {skill.version}
                </span>
              </div>
              <p className="mt-2 break-words text-sm leading-6 text-muted-foreground">
                {skill.description}
              </p>
              <p className="mt-3 text-xs text-muted-foreground">
                Last saved {savedTime(skill.updatedAt)}
              </p>
            </section>
            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            {notice && (
              <p role="status" className="text-sm text-success">
                {notice}
              </p>
            )}
            <SkillContentEditor
              key={editorRevision}
              files={files}
              disabled={busy !== null}
              onChange={changeContent}
              onError={setError}
            />
            <div className="flex flex-wrap items-center justify-end gap-2">
              <Link
                href="/skills"
                onClick={leave}
                aria-disabled={busy !== null}
                className={`${buttonVariants({ variant: "outline" })} aria-disabled:opacity-60`}
              >
                Back to skills
              </Link>
              <Button
                type="button"
                variant="outline"
                disabled={busy !== null || !dirty}
                onClick={discard}
              >
                <Undo2 aria-hidden="true" />
                Discard changes
              </Button>
              <Button type="submit" disabled={busy !== null || !dirty}>
                <Save aria-hidden="true" />
                {busy === "saving" ? "Saving changes…" : "Save changes"}
              </Button>
            </div>
          </form>
          <SkillContentSidebar files={files} editing />
        </div>
      ) : (
        <div className="console-container mt-6 mb-16">
          <section
            className="flex flex-col items-start gap-4 rounded-lg border bg-card p-4"
            aria-busy={busy !== null}
          >
            <BookOpen
              aria-hidden="true"
              className="size-7 text-muted-foreground"
            />
            <div>
              <h2 className="text-lg font-semibold">
                {missing
                  ? "Skill not found"
                  : busy === "loading"
                    ? "Loading skill…"
                    : "Unable to load skill"}
              </h2>
              <p
                className="mt-2 text-sm text-muted-foreground"
                role={error ? "alert" : undefined}
              >
                {missing
                  ? "This skill is no longer available in the selected account context."
                  : error || "Reading the saved entry point and resources."}
              </p>
            </div>
            <div className="flex flex-wrap gap-3">
              {!missing && (
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy !== null}
                  onClick={() => void load()}
                >
                  <RefreshCw
                    aria-hidden="true"
                    className={busy === "loading" ? "animate-spin" : undefined}
                  />
                  {busy === "loading" ? "Loading…" : "Retry"}
                </Button>
              )}
              <Link
                href="/skills"
                className={buttonVariants({ variant: "outline" })}
              >
                Back to skills
              </Link>
            </div>
          </section>
        </div>
      )}
    </main>
  );
}
