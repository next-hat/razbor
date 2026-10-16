"use client";

import { useEffect, useState } from "react";
import { ExternalLink, RefreshCw } from "lucide-react";

import { Alert, AlertDescription } from "@web/components/ui/alert.js";
import { Button, buttonVariants } from "@web/components/ui/button.js";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@web/components/ui/field.js";
import { Input } from "@web/components/ui/input.js";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@web/components/ui/select.js";

type GithubApp = {
  id: string;
  name: string;
  slug: string;
  webUrl: string;
  installUrl: string;
  callbackBase: string;
};

type GithubRepository = {
  installationId: string;
  id: string;
  fullName: string;
  defaultBranch: string;
  private: boolean;
  archived: boolean;
};

export type GithubAppSelection = {
  githubAppId: string;
  installationId: string;
  githubRepositoryId: string;
  repositoryUrl: string;
  defaultBranch: string;
  appName: string;
  callbackBase: string;
};

/** Create an operator-owned App or select a repository granted to a saved App. */
export function GithubAppConnection({
  initialAppId,
  selection,
  callbackBase,
  onCallbackBaseChange,
  onChange,
  disabled = false,
}: Readonly<{
  initialAppId?: string;
  selection?: GithubAppSelection;
  callbackBase: string;
  onCallbackBaseChange: (value: string) => void;
  onChange: (value: GithubAppSelection | undefined) => void;
  disabled?: boolean;
}>) {
  const [apps, setApps] = useState<GithubApp[]>();
  const [appId, setAppId] = useState(
    selection?.githubAppId ?? initialAppId ?? "",
  );
  const [repositories, setRepositories] = useState<GithubRepository[]>();
  const [name, setName] = useState("");
  const [organization, setOrganization] = useState("");
  const [instanceUrl, setInstanceUrl] = useState("");
  const [appError, setAppError] = useState("");
  const [repositoryError, setRepositoryError] = useState("");
  const [creationError, setCreationError] = useState("");
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const selectedApp = apps?.find((app) => app.id === appId);

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/github-apps", {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        const result = (await response.json()) as {
          apps: GithubApp[];
          error?: string;
        };
        if (!response.ok)
          throw new Error(result.error || "Unable to load GitHub Apps.");
        if (controller.signal.aborted) return;
        setApps(result.apps);
        setAppError("");
        setAppId((current) =>
          current === "new" || result.apps.some((app) => app.id === current)
            ? current
            : (result.apps[0]?.id ?? "new"),
        );
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setAppError(
            error instanceof Error
              ? error.message
              : "Unable to load GitHub Apps.",
          );
      });
    return () => controller.abort();
  }, [refresh]);

  useEffect(() => {
    if (!appId || appId === "new") return;
    const controller = new AbortController();
    void fetch(`/api/github-apps/${encodeURIComponent(appId)}/repositories`, {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        const result = (await response.json()) as {
          repositories: GithubRepository[];
          error?: string;
        };
        if (!response.ok)
          throw new Error(
            result.error || "Unable to load installed repositories.",
          );
        if (controller.signal.aborted) return;
        setRepositories(
          result.repositories.filter((repository) => !repository.archived),
        );
        setRepositoryError("");
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setRepositoryError(
            error instanceof Error
              ? error.message
              : "Unable to load installed repositories.",
          );
      });
    return () => controller.abort();
  }, [appId, refresh]);

  /** Clear the selected repository before rechecking the App's current installation grants. */
  function refreshRepositories() {
    onChange(undefined);
    setRepositories(undefined);
    setRepositoryError("");
    setAppError("");
    setRefresh((current) => current + 1);
  }

  /** Start the session-bound manifest flow through GitHub's native form submission. */
  async function createApp() {
    if (busy || disabled) return;
    setBusy(true);
    setCreationError("");
    try {
      const response = await fetch("/api/github-apps/manifest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          callbackBase: callbackBase.trim(),
          ...(organization.trim() ? { organization: organization.trim() } : {}),
          ...(instanceUrl.trim() ? { instanceUrl: instanceUrl.trim() } : {}),
        }),
      });
      const result = (await response.json()) as {
        action?: string;
        manifest?: object;
        error?: string;
      };
      if (!response.ok || !result.action || !result.manifest)
        throw new Error(result.error || "Unable to start GitHub App creation.");
      const form = document.createElement("form");
      form.method = "POST";
      form.action = result.action;
      const manifest = document.createElement("input");
      manifest.type = "hidden";
      manifest.name = "manifest";
      manifest.value = JSON.stringify(result.manifest);
      form.append(manifest);
      document.body.append(form);
      form.submit();
      form.remove();
    } catch (error) {
      setCreationError(
        error instanceof Error ? error.message : "Unable to create GitHub App.",
      );
    } finally {
      setBusy(false);
    }
  }

  const appOptions = [
    ...(apps ?? []).map((app) => ({ value: app.id, label: app.name })),
    { value: "new", label: "Create your own GitHub App" },
  ];
  const repositoryOptions = [
    { value: null, label: "Select a repository" },
    ...(repositories ?? []).map((repository) => ({
      value: `${repository.installationId}:${repository.id}`,
      label: repository.fullName,
    })),
  ];

  return (
    <FieldGroup aria-busy={busy || (!apps && !appError)}>
      {appError && (
        <Alert variant="destructive">
          <AlertDescription role="alert">{appError}</AlertDescription>
        </Alert>
      )}
      {!apps && !appError && (
        <p role="status" className="text-sm text-muted-foreground">
          Loading GitHub Apps…
        </p>
      )}
      {appError && (
        <Button
          type="button"
          variant="outline"
          onClick={refreshRepositories}
          disabled={disabled}
        >
          Retry loading Apps
        </Button>
      )}
      {apps && (
        <Field data-disabled={disabled || busy}>
          <FieldLabel htmlFor="github-app">GitHub App</FieldLabel>
          <Select
            items={appOptions}
            value={appId}
            disabled={disabled || busy}
            onValueChange={(value) => {
              if (!value || value === appId) return;
              setAppId(value);
              setRepositories(undefined);
              setRepositoryError("");
              setCreationError("");
              onChange(undefined);
            }}
          >
            <SelectTrigger id="github-app" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent alignItemWithTrigger={false}>
              <SelectGroup>
                {appOptions.map((app) => (
                  <SelectItem key={app.value} value={app.value}>
                    {app.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          <FieldDescription>
            Your account or organization owns the App. Its credentials stay in
            this razbor instance.
          </FieldDescription>
        </Field>
      )}
      {appId === "new" && (
        <FieldGroup>
          {creationError && (
            <Alert variant="destructive">
              <AlertDescription role="alert">{creationError}</AlertDescription>
            </Alert>
          )}
          <Field data-disabled={disabled || busy}>
            <FieldLabel htmlFor="github-app-name">App name</FieldLabel>
            <Input
              id="github-app-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Acme Razbor"
              autoComplete="off"
              maxLength={100}
              required
              disabled={disabled || busy}
            />
            <FieldDescription>
              Choose a unique name for your review bot on GitHub.
            </FieldDescription>
          </Field>
          <Field data-disabled={disabled || busy}>
            <FieldLabel htmlFor="github-app-callback">
              Webhook callback base URL
            </FieldLabel>
            <Input
              id="github-app-callback"
              type="url"
              pattern="https://.*"
              value={callbackBase}
              onChange={(event) => onCallbackBaseChange(event.target.value)}
              placeholder="https://razbor.example.com"
              maxLength={2048}
              required
              disabled={disabled || busy}
            />
            <FieldDescription>
              The public HTTPS address GitHub can reach for this instance's
              webhooks.
            </FieldDescription>
          </Field>
          <details
            onInvalidCapture={(event) => {
              event.currentTarget.open = true;
            }}
          >
            <summary className="w-fit cursor-pointer text-sm font-medium">
              Organization and enterprise options
            </summary>
            <FieldGroup className="mt-4">
              <Field data-disabled={disabled || busy}>
                <FieldLabel htmlFor="github-app-organization">
                  Organization (optional)
                </FieldLabel>
                <Input
                  id="github-app-organization"
                  value={organization}
                  onChange={(event) => setOrganization(event.target.value)}
                  placeholder="acme"
                  autoComplete="off"
                  maxLength={100}
                  disabled={disabled || busy}
                />
                <FieldDescription>
                  Leave blank to create the App under your personal account.
                </FieldDescription>
              </Field>
              <Field data-disabled={disabled || busy}>
                <FieldLabel htmlFor="github-app-instance">
                  GitHub instance URL (optional)
                </FieldLabel>
                <Input
                  id="github-app-instance"
                  type="url"
                  pattern="https://.*"
                  value={instanceUrl}
                  onChange={(event) => setInstanceUrl(event.target.value)}
                  placeholder="https://github.example.com"
                  autoComplete="off"
                  maxLength={2048}
                  disabled={disabled || busy}
                />
                <FieldDescription>Leave blank for github.com.</FieldDescription>
              </Field>
            </FieldGroup>
          </details>
          <div className="flex flex-col items-start gap-2">
            <Button
              type="button"
              disabled={
                disabled || busy || !name.trim() || !callbackBase.trim()
              }
              onClick={(event) => {
                if (event.currentTarget.form?.reportValidity())
                  void createApp();
              }}
            >
              {busy ? "Opening GitHub…" : "Create App on GitHub"}
              <ExternalLink data-icon="inline-end" />
            </Button>
            <p className="text-sm text-muted-foreground">
              Approve the prefilled permissions on GitHub, then install the App
              and select repositories. GitHub returns you here to finish setup.
            </p>
          </div>
        </FieldGroup>
      )}
      {selectedApp && (
        <FieldGroup aria-busy={!repositories && !repositoryError}>
          {repositoryError && (
            <Alert variant="destructive">
              <AlertDescription role="alert">
                {repositoryError}
              </AlertDescription>
            </Alert>
          )}
          {!repositories && !repositoryError && (
            <p role="status" className="text-sm text-muted-foreground">
              Checking installed repositories…
            </p>
          )}
          {repositories && repositories.length > 0 && (
            <Field data-disabled={disabled}>
              <FieldLabel htmlFor="github-app-repository">
                Repository
              </FieldLabel>
              <Select
                items={repositoryOptions}
                value={
                  selection
                    ? `${selection.installationId}:${selection.githubRepositoryId}`
                    : null
                }
                disabled={disabled}
                onValueChange={(value) => {
                  const repository = repositories.find(
                    (item) => `${item.installationId}:${item.id}` === value,
                  );
                  onChange(
                    repository
                      ? {
                          githubAppId: selectedApp.id,
                          installationId: repository.installationId,
                          githubRepositoryId: repository.id,
                          repositoryUrl: `${selectedApp.webUrl.replace(/\/$/, "")}/${repository.fullName}`,
                          defaultBranch: repository.defaultBranch,
                          appName: selectedApp.name,
                          callbackBase: selectedApp.callbackBase,
                        }
                      : undefined,
                  );
                }}
              >
                <SelectTrigger id="github-app-repository" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent alignItemWithTrigger={false}>
                  <SelectGroup>
                    {repositoryOptions.map((repository) => (
                      <SelectItem
                        key={repository.value ?? "none"}
                        value={repository.value}
                      >
                        {repository.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
              <FieldDescription>
                Only non-archived repositories accessible to this App are
                listed.
              </FieldDescription>
            </Field>
          )}
          {repositories?.length === 0 && (
            <Alert>
              <AlertDescription>
                No repositories are available yet. Install the App on your
                account or organization and grant it access to a repository.
              </AlertDescription>
            </Alert>
          )}
          <div className="flex flex-wrap gap-2">
            <a
              href={selectedApp.installUrl}
              target="_blank"
              rel="noopener noreferrer"
              className={buttonVariants({ variant: "outline" })}
            >
              Install App / manage access
              <ExternalLink data-icon="inline-end" />
            </a>
            <Button
              type="button"
              variant="outline"
              onClick={refreshRepositories}
              disabled={disabled}
            >
              <RefreshCw data-icon="inline-start" />
              Refresh repositories
            </Button>
          </div>
          <p className="text-sm text-muted-foreground">
            After changing access on GitHub, return here and refresh the list.
          </p>
        </FieldGroup>
      )}
    </FieldGroup>
  );
}
