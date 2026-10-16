"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation.js";
import { KeyRound, RotateCw, Trash2 } from "lucide-react";

import type { getRepository } from "@razbor/database";

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
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@web/components/ui/field.js";
import { Input } from "@web/components/ui/input.js";
import { Separator } from "@web/components/ui/separator.js";

type Repository = NonNullable<Awaited<ReturnType<typeof getRepository>>>;

const setupLabels = {
  pending: "Setup pending",
  indexing: "Indexing",
  ready: "Index ready",
  error: "Setup needs attention",
};

type RepositoryAction = "setup" | "token" | "delete";

const actionMethods = { setup: "POST", token: "PATCH", delete: "DELETE" };

const setupDescriptions = {
  pending: "Repository registered. Webhook and index setup are pending.",
  indexing: "Repository registered. Its first index is being prepared.",
  error: "Setup did not complete. Check the error below and retry.",
  ready: "Repository index is ready.",
};

/**
 * Builds only the fields needed for token replacement, deletion confirmation, or setup
 * retry.
 */
function repositoryUpdateBody(
  action: RepositoryAction,
  accessToken: string,
  confirmation: string,
) {
  if (action === "token") return { accessToken: accessToken.trim() };
  if (action === "delete") return { confirmation };
  return {};
}

/**
 * Chooses the retry label for setup or deletion, giving the active request state
 * precedence.
 */
function retryLabel(busy: boolean, deleting: boolean) {
  if (busy) return "Retrying…";
  return deleting ? "Retry deletion" : "Retry setup";
}

/**
 * Manages connection credentials and deletion while polling incomplete setup and
 * redirecting after repository removal.
 */
export function RepositoryManagement({
  id,
  initialRepository,
}: Readonly<{
  id: string;
  initialRepository?: Awaited<ReturnType<typeof getRepository>>;
}>) {
  const router = useRouter();
  const [repository, setRepository] = useState(initialRepository);
  const [busy, setBusy] = useState<RepositoryAction | null>(null);
  const [error, setError] = useState("");
  const [refreshError, setRefreshError] = useState(false);
  const [message, setMessage] = useState("");
  const [accessToken, setAccessToken] = useState("");
  const [tokenOpen, setTokenOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const deleting = repository?.status === "deleting";
  const repositoryName = repository?.selector ?? repository?.configKey ?? "";
  const setupState = repository?.setupState;
  const status = repository?.status;

  useEffect(() => {
    if (
      status &&
      status !== "deleting" &&
      setupState !== "pending" &&
      setupState !== "indexing"
    )
      return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let removed = false;
    /**
     * Refreshes repository state until aborted or removed, retaining a known deletion
     * state against an older response.
     */
    async function refresh() {
      try {
        const response = await fetch(`/api/repositories/${id}`, {
          cache: "no-store",
          signal: controller.signal,
        });
        if (response.status === 404) {
          removed = true;
          router.replace("/repos");
          router.refresh();
          return;
        }
        if (!response.ok) throw new Error("Repository refresh failed");
        const next = (await response.json()) as Repository;
        if (!controller.signal.aborted) {
          setRepository((current) =>
            current?.status === "deleting" && next.status !== "deleting"
              ? current
              : next,
          );
          setRefreshError(false);
        }
      } catch {
        if (!controller.signal.aborted) setRefreshError(true);
      } finally {
        if (!controller.signal.aborted && !removed)
          timer = setTimeout(() => void refresh(), 3000);
      }
    }
    void refresh();
    return () => {
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [id, router, setupState, status]);

  /**
   * Submits a repository action, clears submitted credentials on success, and refreshes
   * connection state after non-deletion changes.
   */
  async function update(action: RepositoryAction) {
    if (busy || !repository) return;
    if (action === "delete" && !deleting && confirmation !== repositoryName)
      return;
    setBusy(action);
    setError("");
    setMessage("");
    try {
      const response = await fetch(
        `/api/repositories/${id}${action === "setup" ? "/setup" : ""}`,
        {
          method: actionMethods[action],
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            repositoryUpdateBody(
              action,
              accessToken,
              deleting ? repositoryName : confirmation,
            ),
          ),
        },
      );
      const result = (await response.json()) as { error?: string };
      if (!response.ok)
        throw new Error(result.error || "Unable to update repository");
      if (action === "delete") {
        setRepository((current) =>
          current
            ? { ...current, status: "deleting", setupError: null }
            : current,
        );
        setDeleteOpen(false);
        setConfirmation("");
        setAccessToken("");
        setTokenOpen(false);
        return;
      }
      if (action === "token") {
        setAccessToken("");
        setTokenOpen(false);
        setMessage("Access token replaced.");
      }
      const updated = await fetch(`/api/repositories/${id}`, {
        cache: "no-store",
      });
      if (!updated.ok)
        throw new Error(
          "Settings saved, but repository status could not be refreshed. Reload this page.",
        );
      setRepository((await updated.json()) as Repository);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to update repository");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <section
        className="console-card grid min-w-0 gap-6 lg:grid-cols-[240px_minmax(0,1fr)]"
        aria-labelledby="repository-management-title"
      >
        <div className="flex flex-col gap-2">
          <h2
            id="repository-management-title"
            className="text-base font-semibold"
          >
            Repository connection
          </h2>
          <p className="text-sm leading-relaxed text-muted-foreground">
            Forge access and setup for this repository.
          </p>
        </div>
        <div className="flex min-w-0 flex-col gap-5">
          {refreshError && (
            <Alert variant="destructive">
              <AlertDescription>
                Repository status is unavailable. Retrying…
              </AlertDescription>
            </Alert>
          )}
          {error && !deleteOpen && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          {!repository ? (
            <output className="block text-sm text-muted-foreground">
              Loading repository settings…
            </output>
          ) : (
            <>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <span className="min-w-0 break-all font-medium">
                  {repository.metadata?.fullPath ?? repositoryName}
                </span>
                <Badge
                  variant={repository.setupError ? "destructive" : "secondary"}
                >
                  {deleting ? "Deleting" : setupLabels[repository.setupState]}
                </Badge>
              </div>
              <output className="block text-sm text-muted-foreground">
                {deleting
                  ? "Stopping work and removing local repository data. This page will return to the repository list when deletion is complete."
                  : setupDescriptions[repository.setupState]}
              </output>
              {repository.setupError && (
                <Alert variant="destructive">
                  <AlertDescription>{repository.setupError}</AlertDescription>
                </Alert>
              )}
              {!deleting && (
                <p className="text-xs text-muted-foreground">
                  Index branch:{" "}
                  <span className="font-mono">{repository.branch}</span>
                </p>
              )}
              {((!deleting && repository.setupState === "error") ||
                (deleting && repository.setupError)) && (
                <div>
                  <Button
                    variant="outline"
                    disabled={!!busy}
                    onClick={() => void update(deleting ? "delete" : "setup")}
                  >
                    <RotateCw data-icon="inline-start" />
                    {retryLabel(!!busy, deleting)}
                  </Button>
                </div>
              )}
              {repository.connectionMode === "github-app" ? (
                <p className="text-sm leading-relaxed text-muted-foreground">
                  Connected through your GitHub App. Installation tokens refresh
                  automatically. If access is revoked, restore this repository
                  in the App installation on GitHub, then retry setup.
                </p>
              ) : (
                <details
                  open={tokenOpen}
                  onToggle={(event) => {
                    setTokenOpen(event.currentTarget.open);
                    if (!event.currentTarget.open) setAccessToken("");
                  }}
                >
                  <summary className="w-fit cursor-pointer text-sm font-medium">
                    Replace access token
                  </summary>
                  <form
                    className="mt-4 flex flex-col gap-4"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void update("token");
                    }}
                  >
                    <FieldGroup>
                      <Field data-disabled={!!busy}>
                        <FieldLabel htmlFor="replacement-access-token">
                          Bot access token
                        </FieldLabel>
                        <Input
                          id="replacement-access-token"
                          type="password"
                          autoComplete="new-password"
                          placeholder="Paste a new token"
                          value={accessToken}
                          onChange={(event) =>
                            setAccessToken(event.target.value)
                          }
                          required
                          disabled={!!busy}
                        />
                        <FieldDescription>
                          Use the same bot identity with repository read and
                          review/comment write access.
                          {repository.connectionMode === "managed" &&
                            " Webhook management permission is also required."}{" "}
                          The saved token is never displayed.
                        </FieldDescription>
                      </Field>
                    </FieldGroup>
                    <div>
                      <Button
                        type="submit"
                        variant="outline"
                        disabled={!!busy || !accessToken.trim()}
                      >
                        <KeyRound data-icon="inline-start" />
                        {busy === "token" ? "Saving…" : "Replace token"}
                      </Button>
                    </div>
                  </form>
                </details>
              )}
              {message && <output className="block text-sm">{message}</output>}
            </>
          )}
        </div>
      </section>
      {repository && !deleting && (
        <>
          <Separator />
          <section
            className="console-card grid min-w-0 gap-6 lg:grid-cols-[240px_minmax(0,1fr)]"
            aria-labelledby="delete-repository-title"
          >
            <div className="flex flex-col gap-2">
              <h2
                id="delete-repository-title"
                className="text-base font-semibold"
              >
                Delete repository
              </h2>
              <p className="text-sm leading-relaxed text-muted-foreground">
                Remove this repository and its data from razbor.
              </p>
            </div>
            <div className="flex flex-col items-start gap-4">
              <p className="text-sm leading-relaxed text-muted-foreground">
                Deletes local reviews, indexes, checkout data, and repository
                credentials. The repository on its forge is kept.
              </p>
              <Dialog
                open={deleteOpen}
                onOpenChange={(value) => {
                  if (busy) return;
                  setDeleteOpen(value);
                  setConfirmation("");
                  setError("");
                }}
              >
                <DialogTrigger
                  render={<Button variant="destructive" disabled={!!busy} />}
                >
                  <Trash2 data-icon="inline-start" />
                  Delete repository
                </DialogTrigger>
                <DialogContent
                  className="max-h-[90dvh] overflow-y-auto sm:max-w-lg"
                  showCloseButton={!busy}
                >
                  <DialogHeader>
                    <DialogTitle>Delete repository from razbor?</DialogTitle>
                    <DialogDescription>
                      This permanently deletes local reviews, indexes, checkout
                      data, and repository credentials.
                      {repository.connectionMode === "manual"
                        ? " Remove the webhook you created from GitHub yourself."
                        : repository.connectionMode === "github-app"
                          ? " Your GitHub App installation and its shared webhook are kept."
                          : " The webhook created by razbor is removed."}{" "}
                      The remote repository and its source code are kept.
                    </DialogDescription>
                  </DialogHeader>
                  <form
                    className="flex flex-col gap-6"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void update("delete");
                    }}
                  >
                    {error && (
                      <Alert variant="destructive">
                        <AlertDescription>{error}</AlertDescription>
                      </Alert>
                    )}
                    <FieldGroup>
                      <Field
                        data-disabled={!!busy}
                        data-invalid={
                          confirmation.length > 0 &&
                          confirmation !== repositoryName
                        }
                      >
                        <FieldLabel htmlFor="delete-repository-confirmation">
                          Type the repository path to confirm
                        </FieldLabel>
                        <FieldDescription>
                          <code className="break-all select-all">
                            {repositoryName}
                          </code>
                        </FieldDescription>
                        <Input
                          id="delete-repository-confirmation"
                          value={confirmation}
                          onChange={(event) =>
                            setConfirmation(event.target.value)
                          }
                          autoComplete="off"
                          required
                          disabled={!!busy}
                          aria-invalid={
                            confirmation.length > 0 &&
                            confirmation !== repositoryName
                          }
                        />
                      </Field>
                    </FieldGroup>
                    <DialogFooter>
                      <Button
                        type="button"
                        variant="outline"
                        disabled={!!busy}
                        onClick={() => {
                          setDeleteOpen(false);
                          setConfirmation("");
                          setError("");
                        }}
                      >
                        Cancel
                      </Button>
                      <Button
                        type="submit"
                        variant="destructive"
                        disabled={!!busy || confirmation !== repositoryName}
                      >
                        <Trash2 data-icon="inline-start" />
                        {busy === "delete" ? "Deleting…" : "Delete repository"}
                      </Button>
                    </DialogFooter>
                  </form>
                </DialogContent>
              </Dialog>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
