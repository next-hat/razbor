"use client";

import { useId, useState } from "react";
import { Copy, Plus } from "lucide-react";

import type { RunnerView } from "@razbor/contracts";

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
  FieldLegend,
  FieldSet,
} from "@web/components/ui/field.js";
import { Input } from "@web/components/ui/input.js";
import { formatUtc } from "@web/lib/date.js";

export type RunnerRepository = { id: string; name: string };

type Enrollment = {
  runner: RunnerView;
  enrollmentToken: string;
  expiresAt: string;
};

/**
 * Quotes one shell argument, escaping embedded single quotes without interpreting its
 * contents.
 */
const shellQuote = (value: string) =>
  "'" + value.replaceAll("'", "'\"'\"'") + "'";

/**
 * Builds a one-time Docker enrollment command only for a valid app origin, requiring
 * explicit opt-in for HTTP.
 */
function EnrollmentCommand({
  enrollment,
}: Readonly<{ enrollment: Enrollment }>) {
  const id = useId();
  const [url, setUrl] = useState(() => window.location.origin);
  const [allowHttp, setAllowHttp] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  let origin = "";
  try {
    const parsed = new URL(url);
    if (
      !parsed.username &&
      !parsed.password &&
      !parsed.search &&
      !parsed.hash &&
      parsed.pathname === "/" &&
      (parsed.protocol === "https:" ||
        (allowHttp && parsed.protocol === "http:"))
    )
      origin = parsed.origin;
  } catch {
    /* Keep the command unavailable until the URL is complete. */
  }
  const name = `razbor-${enrollment.runner.id}`;
  const command = origin
    ? [
        `docker run -d --name ${name} --restart unless-stopped --init --stop-timeout 45`,
        "  --runtime kata --cap-add ALL",
        "  --security-opt seccomp=unconfined --security-opt apparmor=unconfined",
        "  --security-opt writable-cgroups=true",
        "  --sysctl net.ipv4.ip_forward=1 --sysctl net.ipv6.conf.default.forwarding=1 --sysctl net.ipv6.conf.all.forwarding=1",
        "  --memory 6g --memory-swap 6g --cpus 4 --pids-limit 2048",
        "  --tmpfs /var/lib/docker:rw,nosuid,size=4g",
        `  --mount type=volume,src=${name},dst=/job-data`,
        `  razbor-runner:0.1.0 --url ${shellQuote(origin)}${allowHttp && origin.startsWith("http:") ? " --allow-http" : ""}`,
        `  --enrollment-token ${shellQuote(enrollment.enrollmentToken)}`,
      ].join(" \\\n")
    : "";
  /**
   * Copies the enrollment command and exposes manual-copy guidance if clipboard access
   * fails.
   */
  async function copy() {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setCopyError(false);
    } catch {
      setCopyError(true);
    }
  }
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <Alert>
        <AlertDescription>
          Enrollment is shown once and expires{" "}
          <time dateTime={enrollment.expiresAt}>
            {formatUtc(enrollment.expiresAt)}
          </time>
          . Run this command on the runner host.
        </AlertDescription>
      </Alert>
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor={`${id}-url`}>
            App URL reachable from the runner
          </FieldLabel>
          <Input
            id={`${id}-url`}
            type="url"
            value={url}
            onChange={(event) => {
              setUrl(event.target.value);
              setCopied(false);
            }}
            placeholder="https://razbor.example.com"
            autoComplete="off"
            spellCheck={false}
          />
          <FieldDescription>
            Use the app origin. A remote host cannot reach this machine through
            localhost.
          </FieldDescription>
        </Field>
        {url.startsWith("http:") && (
          <Field orientation="horizontal">
            <input
              id={`${id}-http`}
              type="checkbox"
              checked={allowHttp}
              onChange={(event) => setAllowHttp(event.target.checked)}
            />
            <FieldLabel htmlFor={`${id}-http`}>
              Allow unencrypted HTTP on a trusted development network
            </FieldLabel>
          </Field>
        )}
      </FieldGroup>
      <p className="text-sm text-muted-foreground">
        The host needs Docker, Kata, and the matching razbor-runner:0.1.0 image
        built or loaded locally. Runner data is kept in its named volume.
      </p>
      {command ? (
        <>
          <pre
            className="max-h-64 overflow-auto rounded-lg border bg-muted p-4 text-xs leading-relaxed"
            tabIndex={0}
            aria-label="Runner enrollment command"
          >
            <code>{command}</code>
          </pre>
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="outline" onClick={() => void copy()}>
              <Copy data-icon="inline-start" />
              {copied ? "Copied" : "Copy command"}
            </Button>
            <p role="status" className="text-xs text-muted-foreground">
              {copyError
                ? "Select and copy the command above."
                : copied
                  ? "Command copied to clipboard."
                  : "This token can enroll only this runner, once."}
            </p>
          </div>
        </>
      ) : (
        <p role="status" className="text-sm text-muted-foreground">
          Enter an HTTPS app URL to generate the command.
        </p>
      )}
    </div>
  );
}

/**
 * Registers and manages a runner, its repository grants, lifecycle state, and one-time
 * enrollment command. All-repository access includes future repositories. Default
 * repository choices supplement existing grants and apply only on save.
 */
export function RunnerForm({
  runner,
  repositories,
  defaultRepositoryIds = [],
  disabled,
  onSaved,
}: Readonly<{
  runner?: RunnerView;
  repositories: RunnerRepository[];
  defaultRepositoryIds?: string[];
  disabled?: boolean;
  onSaved: (runner: RunnerView) => void;
}>) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [allRepositories, setAllRepositories] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [enrollment, setEnrollment] = useState<Enrollment>();
  const [confirm, setConfirm] = useState<"revoke" | "enroll">();
  /**
   * Resets editable runner settings and discards any displayed enrollment token when
   * the dialog changes state, preserving existing grants alongside suggested choices.
   */
  function changeOpen(value: boolean) {
    if (busy) return;
    setOpen(value);
    setError("");
    setConfirm(undefined);
    setEnrollment(undefined);
    if (value) {
      setName(runner?.name ?? "");
      setAllRepositories(runner?.allRepositories ?? false);
      setSelected([
        ...new Set([...(runner?.repositoryIds ?? []), ...defaultRepositoryIds]),
      ]);
    }
  }
  /**
   * Submits a runner mutation; enrollment responses stay open to display their one-time
   * token, while ordinary saves close the dialog.
   */
  async function request(
    action: "save" | "drain" | "resume" | "revoke" | "enroll",
  ) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch(
        runner
          ? `/api/runners/${runner.id}${action === "enroll" ? "/enrollment" : ""}`
          : "/api/runners",
        {
          method: !runner || action === "enroll" ? "POST" : "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            action === "save"
              ? { name: name.trim(), repositoryIds: selected, allRepositories }
              : action === "enroll"
                ? {}
                : {
                    state:
                      action === "drain"
                        ? "draining"
                        : action === "resume"
                          ? "enabled"
                          : "revoked",
                  },
          ),
        },
      );
      const result = (await response.json()) as RunnerView &
        Enrollment & { error?: string };
      if (!response.ok)
        throw new Error(result.error || "Unable to save the runner.");
      if (!runner || action === "enroll") {
        setEnrollment(result);
        onSaved(result.runner);
        setConfirm(undefined);
      } else {
        onSaved(result);
        setOpen(false);
      }
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Unable to save the runner.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogTrigger
        render={<Button variant={runner ? "outline" : "default"} />}
        disabled={disabled}
        aria-label={runner ? `Manage ${runner.name}` : undefined}
      >
        {!runner && <Plus data-icon="inline-start" />}
        {runner ? "Manage" : "Register runner"}
      </DialogTrigger>
      <DialogContent
        className="max-h-[90dvh] overflow-y-auto sm:max-w-xl"
        showCloseButton={!busy}
      >
        <DialogHeader>
          <DialogTitle>
            {enrollment
              ? `Start ${enrollment.runner.name}`
              : confirm === "revoke"
                ? "Revoke runner access?"
                : confirm === "enroll"
                  ? "Replace runner credentials?"
                  : runner
                    ? "Manage runner"
                    : "Register runner"}
          </DialogTitle>
          <DialogDescription>
            {enrollment
              ? "Connect this host to razbor. No configuration file is required."
              : confirm === "revoke"
                ? "Active work will lose access and stop by its lease deadline. The runner and review history remain saved."
                : confirm === "enroll"
                  ? "This invalidates existing credentials and active work. A new one-time enrollment command will reconnect this runner."
                  : "Choose which repositories this host can review. Assignments apply to new work."}
          </DialogDescription>
        </DialogHeader>
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {enrollment ? (
          <>
            <EnrollmentCommand enrollment={enrollment} />
            <DialogFooter>
              <Button onClick={() => changeOpen(false)}>Done</Button>
            </DialogFooter>
          </>
        ) : confirm ? (
          <DialogFooter>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => setConfirm(undefined)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() => void request(confirm)}
            >
              {busy
                ? "Updating…"
                : confirm === "revoke"
                  ? "Revoke access"
                  : "Replace credentials"}
            </Button>
          </DialogFooter>
        ) : (
          <form
            className="flex flex-col gap-4"
            aria-busy={busy}
            onSubmit={(event) => {
              event.preventDefault();
              void request("save");
            }}
          >
            <FieldGroup>
              <Field data-disabled={busy}>
                <FieldLabel htmlFor={`${id}-name`}>Runner name</FieldLabel>
                <Input
                  id={`${id}-name`}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="build-host-01"
                  maxLength={100}
                  required
                  disabled={busy}
                  autoComplete="off"
                />
              </Field>
              <FieldSet disabled={busy}>
                <FieldLegend>Repositories</FieldLegend>
                <FieldDescription>
                  Allow all current and future repositories, or select specific
                  repositories below. You can change this later.
                </FieldDescription>
                <Field orientation="horizontal" data-disabled={busy}>
                  <input
                    id={`${id}-all-repositories`}
                    type="checkbox"
                    checked={allRepositories}
                    onChange={(event) =>
                      setAllRepositories(event.target.checked)
                    }
                    disabled={busy}
                  />
                  <FieldLabel htmlFor={`${id}-all-repositories`}>
                    All repositories, including future ones
                  </FieldLabel>
                </Field>
                <FieldGroup
                  className="max-h-56 overflow-y-auto"
                  data-slot="checkbox-group"
                >
                  {repositories.length ? (
                    repositories.map((repository) => (
                      <Field
                        key={repository.id}
                        orientation="horizontal"
                        data-disabled={busy || allRepositories}
                      >
                        <input
                          id={`${id}-${repository.id}`}
                          type="checkbox"
                          checked={
                            allRepositories || selected.includes(repository.id)
                          }
                          onChange={(event) =>
                            setSelected((current) =>
                              event.target.checked
                                ? [...current, repository.id]
                                : current.filter(
                                    (value) => value !== repository.id,
                                  ),
                            )
                          }
                          disabled={busy || allRepositories}
                        />
                        <FieldLabel
                          htmlFor={`${id}-${repository.id}`}
                          className="min-w-0 break-all"
                        >
                          {repository.name}
                        </FieldLabel>
                      </Field>
                    ))
                  ) : (
                    <FieldDescription>
                      No repositories yet. Choose all repositories to include
                      future additions, or add a repository and assign it here.
                    </FieldDescription>
                  )}
                </FieldGroup>
              </FieldSet>
            </FieldGroup>
            {runner && (
              <div className="flex flex-col gap-3">
                <p className="text-xs text-muted-foreground">
                  Drain allows active reviews to finish. Revoke stops access.
                  Re-enrollment keeps this runner’s identity and repository
                  assignments.
                </p>
                <div className="flex flex-wrap gap-2">
                  {runner.state !== "revoked" && (
                    <Button
                      type="button"
                      variant="outline"
                      disabled={busy}
                      onClick={() =>
                        void request(
                          runner.state === "draining" ? "resume" : "drain",
                        )
                      }
                    >
                      {runner.state === "draining" ? "Resume" : "Drain"}
                    </Button>
                  )}
                  <Button
                    type="button"
                    variant="outline"
                    disabled={busy}
                    onClick={() => setConfirm("enroll")}
                  >
                    {runner.enrolledAt
                      ? "Replace credentials"
                      : "New enrollment command"}
                  </Button>
                  {runner.state !== "revoked" && (
                    <Button
                      type="button"
                      variant="destructive"
                      disabled={busy}
                      onClick={() => setConfirm("revoke")}
                    >
                      Revoke
                    </Button>
                  )}
                </div>
              </div>
            )}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => changeOpen(false)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={busy || !name.trim()}>
                {busy
                  ? "Saving…"
                  : runner
                    ? "Save changes"
                    : "Create enrollment command"}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
