"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link.js";
import { ArrowLeft, ArrowRight, Check, GitBranch } from "lucide-react";

import type { AgentView } from "@razbor/database";

import { AgentSelect } from "@web/components/agent-select.js";
import {
  GithubAppConnection,
  type GithubAppSelection,
} from "@web/components/github-app-connection.js";
import { ConsoleHero } from "@web/components/console-hero.js";
import { RepositorySetup } from "@web/components/repository-setup.js";
import { Alert, AlertDescription } from "@web/components/ui/alert.js";
import { Badge } from "@web/components/ui/badge.js";
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
import { usePoll } from "@web/lib/use-poll.js";

type ForgeType = "forgejo" | "github" | "gitlab";

type VerifiedRepository = {
  fullPath: string;
  webUrl: string;
  visibility: string;
  branch: string;
  botLogin: string;
};

const forgeOptions = [
  { value: "forgejo", label: "Forgejo" },
  { value: "github", label: "GitHub" },
  { value: "gitlab", label: "GitLab" },
];

const forgeGuidance = {
  forgejo: {
    label: "Forgejo",
    repository: "https://forge.example.com/organization/repository",
    instance: "https://forge.example.com",
    token:
      "Give the bot repository admin access for webhook setup. Its token needs read:user, write:repository, and write:issue, with access to all repositories; Forgejo's specific-repository tokens cannot manage webhooks.",
  },
  github: {
    label: "GitHub",
    repository: "https://github.com/organization/repository",
    instance: "https://github.example.com",
    token:
      "Use a bot token with Contents: read, Pull requests: write, and Issues: write for this repository. The bot needs access to create and resolve review threads. You will configure the webhook in GitHub yourself.",
  },
  gitlab: {
    label: "GitLab",
    repository: "https://gitlab.com/group/subgroup/repository",
    instance: "https://gitlab.example.com",
    token:
      "Use a dedicated bot's personal or project access token with the api scope and Maintainer access for webhook setup. Reviews and thread replies use this bot identity.",
  },
};

const steps = [
  { title: "Choose forge", description: "Where does your repository live?" },
  {
    title: "Repository and access",
    description: "Choose how razbor accesses your existing repository.",
  },
  {
    title: "Review settings",
    description: "Choose your reviewer and who can request reviews.",
  },
  {
    title: "Confirm and connect",
    description: "Check the details before starting setup.",
  },
];

/** Guides repository registration, retaining unsaved credentials only in memory until creation. */
export function RepositoryWizard({
  initialAgents,
  initialGithubApp,
  githubAppError = false,
  canManageRunners = false,
  canManageAgents = false,
  canManageIndexer = false,
}: Readonly<{
  initialAgents?: AgentView[];
  initialGithubApp?: string;
  githubAppError?: boolean;
  canManageRunners?: boolean;
  canManageAgents?: boolean;
  canManageIndexer?: boolean;
}>) {
  const [step, setStep] = useState(initialGithubApp || githubAppError ? 1 : 0);
  const [forgeType, setForgeType] = useState<ForgeType>(
    initialGithubApp || githubAppError ? "github" : "forgejo",
  );
  const [githubMethod, setGithubMethod] = useState("app");
  const [githubSelection, setGithubSelection] = useState<GithubAppSelection>();
  const [repositoryUrl, setRepositoryUrl] = useState("");
  const [instanceUrl, setInstanceUrl] = useState("");
  const [accessToken, setAccessToken] = useState("");
  const [branch, setBranch] = useState("");
  const [callbackBase, setCallbackBase] = useState("");
  const [senders, setSenders] = useState("");
  const [agentId, setAgentId] = useState<string | null>(null);
  const [verified, setVerified] = useState<VerifiedRepository>();
  const [created, setCreated] = useState<{
    id: string;
    generatedSecret?: string;
  }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(
    githubAppError
      ? "GitHub App setup could not be completed. Try creating the App again."
      : "",
  );
  const heading = useRef<HTMLHeadingElement>(null);
  const { data: agents, setData: setAgents } = usePoll<AgentView[]>(
    "/api/agents?selection=repository",
    initialAgents,
  );
  const guidance = forgeGuidance[forgeType];
  const usesGithubApp = forgeType === "github" && githubMethod === "app";
  const selectedCallback = usesGithubApp
    ? (githubSelection?.callbackBase ?? callbackBase)
    : callbackBase;

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/repositories/setup", {
      signal: controller.signal,
      cache: "no-store",
    })
      .then(async (response) => {
        if (!response.ok) return;
        const defaults = (await response.json()) as { callbackBase?: string };
        if (!controller.signal.aborted && defaults.callbackBase) {
          setCallbackBase((current) => current || defaults.callbackBase || "");
        }
      })
      .catch(() => {
        /* The callback can still be entered manually. */
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    heading.current?.focus();
  }, [step]);

  /** Returns only the connection fields accepted by the read-only verification endpoint. */
  function connectionInput() {
    if (usesGithubApp && githubSelection) {
      return {
        forgeType,
        repositoryUrl: githubSelection.repositoryUrl,
        githubAppId: githubSelection.githubAppId,
        installationId: githubSelection.installationId,
        githubRepositoryId: githubSelection.githubRepositoryId,
        ...(branch.trim() ? { branch: branch.trim() } : {}),
      };
    }
    return {
      forgeType,
      repositoryUrl: repositoryUrl.trim(),
      accessToken: accessToken.trim(),
      ...(instanceUrl.trim() ? { instanceUrl: instanceUrl.trim() } : {}),
      ...(branch.trim() ? { branch: branch.trim() } : {}),
    };
  }

  /** Invalidate checked access whenever the App or installed repository changes. */
  function chooseGithubRepository(selection: GithubAppSelection | undefined) {
    setGithubSelection(selection);
    setVerified(undefined);
    setError("");
  }

  /** Moves backward without discarding the draft, clearing errors from the prior step. */
  function goBack() {
    if (busy) return;
    setError("");
    setStep((current) => Math.max(0, current - 1));
  }

  /** Checks the active step; only the final action persists the repository and starts setup. */
  async function next() {
    if (busy) return;
    setError("");
    if (step === 1 && usesGithubApp && !githubSelection) {
      setError("Select a repository installed on your GitHub App.");
      return;
    }
    if (step === 0) {
      setStep(1);
      return;
    }
    if (step === 2) {
      const permitted = senders
        .split(",")
        .map((sender) => sender.trim())
        .filter(Boolean);
      if (!permitted.length) {
        setError("Enter at least one username that can request reviews.");
        return;
      }
      if (verified?.visibility !== "private" && permitted.includes("*")) {
        setError("Public repositories require explicit usernames.");
        return;
      }
      setStep(3);
      return;
    }
    setBusy(true);
    try {
      if (step === 1) {
        const response = await fetch("/api/repositories/verify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(connectionInput()),
        });
        const result = (await response.json()) as VerifiedRepository & {
          error?: string;
        };
        if (!response.ok)
          throw new Error(
            result.error || "Unable to verify repository access.",
          );
        setVerified(result);
        setStep(2);
      } else {
        const response = await fetch("/api/repositories", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...connectionInput(),
            ...(agentId ? { agentId } : {}),
            callbackBase: selectedCallback.trim(),
            ...(forgeType === "github" && !usesGithubApp
              ? { webhookMode: "manual" }
              : {}),
            permittedSenders: senders
              .split(",")
              .map((sender) => sender.trim())
              .filter(Boolean),
          }),
        });
        const result = (await response.json()) as {
          id?: string;
          generatedSecret?: string;
          error?: string;
        };
        if (!response.ok || !result.id)
          throw new Error(result.error || "Unable to connect repository.");
        setAccessToken("");
        setCreated({ id: result.id, generatedSecret: result.generatedSecret });
      }
    } catch (error) {
      setError(error instanceof Error ? error.message : "Unable to continue.");
    } finally {
      setBusy(false);
    }
  }

  if (created)
    return (
      <RepositorySetup
        id={created.id}
        generatedSecret={created.generatedSecret}
        canManageRunners={canManageRunners}
        canManageIndexer={canManageIndexer}
      />
    );

  return (
    <main className="console-hero-page repository-connect-page flex min-w-0 flex-col">
      <ConsoleHero
        id="repository-connect-title"
        eyebrow="Connected projects"
        title="Connect repository"
        description="Connect an existing repository and prepare it for automated review."
        breadcrumbs={[{ label: "Repositories", href: "/repos" }]}
      >
        <span className="console-hero-status">
          Step {step + 1} of {steps.length}
        </span>
      </ConsoleHero>
      <div className="console-container mt-6 mb-16 flex min-w-0 flex-col gap-6">
        <ol
          aria-label="Repository setup steps"
          className="grid grid-cols-2 gap-3 lg:grid-cols-4"
        >
          {steps.map((item, index) => (
            <li
              key={item.title}
              aria-current={index === step ? "step" : undefined}
              className={`flex min-w-0 items-center gap-3 rounded-xl border bg-card p-4 ${index === step ? "border-primary/40 bg-primary/5" : ""}`}
            >
              <Badge variant={index === step ? "default" : "secondary"}>
                {index < step ? (
                  <Check className="size-3" aria-label="Completed" />
                ) : (
                  index + 1
                )}
              </Badge>
              <span className="text-sm">{item.title}</span>
            </li>
          ))}
        </ol>
        <section
          className="console-card grid min-w-0 gap-6 lg:grid-cols-[240px_minmax(0,1fr)]"
          aria-labelledby="setup-step-title"
        >
          <div className="flex flex-col gap-2">
            <h2
              id="setup-step-title"
              ref={heading}
              tabIndex={-1}
              className="text-base font-semibold outline-none"
            >
              {steps[step].title}
            </h2>
            <p className="text-sm leading-relaxed text-muted-foreground">
              {steps[step].description}
            </p>
            <p className="text-xs text-muted-foreground">
              Step {step + 1} of {steps.length}
            </p>
          </div>
          <form
            className="flex min-w-0 flex-col gap-6"
            aria-busy={busy}
            onSubmit={(event) => {
              if (event.target !== event.currentTarget) return;
              event.preventDefault();
              void next();
            }}
          >
            {error && (
              <Alert variant="destructive">
                <AlertDescription role="alert">{error}</AlertDescription>
              </Alert>
            )}
            {step === 0 && (
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="repository-forge">Forge</FieldLabel>
                  <Select
                    items={forgeOptions}
                    value={forgeType}
                    onValueChange={(value) => {
                      if (value === forgeType) return;
                      if (
                        value === "forgejo" ||
                        value === "github" ||
                        value === "gitlab"
                      ) {
                        setForgeType(value);
                        setAccessToken("");
                        setInstanceUrl("");
                        setVerified(undefined);
                        setError("");
                      }
                    }}
                  >
                    <SelectTrigger id="repository-forge" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent alignItemWithTrigger={false}>
                      <SelectGroup>
                        {forgeOptions.map((forge) => (
                          <SelectItem key={forge.value} value={forge.value}>
                            {forge.label}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                  <FieldDescription>
                    Cloud and self-hosted instances are supported. GitHub can
                    connect through your own App or a bot access token.
                  </FieldDescription>
                </Field>
                {forgeType === "github" && (
                  <Field>
                    <FieldLabel htmlFor="github-connection-method">
                      Connection method
                    </FieldLabel>
                    <Select
                      value={githubMethod}
                      items={[
                        { value: "app", label: "GitHub App (recommended)" },
                        {
                          value: "manual",
                          label: "Manual webhook and access token",
                        },
                      ]}
                      onValueChange={(value) => {
                        if (value !== "app" && value !== "manual") return;
                        setGithubMethod(value);
                        setAccessToken("");
                        setVerified(undefined);
                        setError("");
                      }}
                    >
                      <SelectTrigger
                        id="github-connection-method"
                        className="w-full"
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent alignItemWithTrigger={false}>
                        <SelectGroup>
                          <SelectItem value="app">
                            GitHub App (recommended)
                          </SelectItem>
                          <SelectItem value="manual">
                            Manual webhook and access token
                          </SelectItem>
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                    <FieldDescription>
                      {githubMethod === "app"
                        ? "Create an App owned by your GitHub account or organization. This razbor instance receives its credentials and webhooks."
                        : "Use a bot token, then copy the webhook URL and secret into your repository settings on GitHub."}
                    </FieldDescription>
                  </Field>
                )}
              </FieldGroup>
            )}
            {step === 1 && usesGithubApp && (
              <FieldGroup>
                <GithubAppConnection
                  initialAppId={initialGithubApp}
                  selection={githubSelection}
                  callbackBase={callbackBase}
                  onCallbackBaseChange={setCallbackBase}
                  onChange={chooseGithubRepository}
                  disabled={busy}
                />
                {githubSelection && (
                  <Field data-disabled={busy}>
                    <FieldLabel htmlFor="github-index-branch">
                      Index branch (optional)
                    </FieldLabel>
                    <Input
                      id="github-index-branch"
                      value={branch}
                      placeholder={
                        githubSelection.defaultBranch ||
                        "Use the repository's default branch"
                      }
                      onChange={(event) => {
                        setBranch(event.target.value);
                        setVerified(undefined);
                      }}
                      maxLength={200}
                      disabled={busy}
                    />
                  </Field>
                )}
              </FieldGroup>
            )}
            {step === 1 && !usesGithubApp && (
              <FieldGroup>
                <Field data-disabled={busy}>
                  <FieldLabel htmlFor="repository-url">
                    Repository URL
                  </FieldLabel>
                  <Input
                    id="repository-url"
                    type="url"
                    placeholder={guidance.repository}
                    value={repositoryUrl}
                    onChange={(event) => {
                      setRepositoryUrl(event.target.value);
                      setVerified(undefined);
                    }}
                    required
                    maxLength={2048}
                    disabled={busy}
                    autoComplete="off"
                  />
                  <FieldDescription>
                    The repository's {guidance.label} page or HTTPS clone URL.
                  </FieldDescription>
                </Field>
                <Field data-disabled={busy}>
                  <FieldLabel htmlFor="repository-token">
                    Bot access token
                  </FieldLabel>
                  <Input
                    id="repository-token"
                    type="password"
                    autoComplete="new-password"
                    placeholder="Paste the bot account's access token"
                    value={accessToken}
                    onChange={(event) => {
                      setAccessToken(event.target.value);
                      setVerified(undefined);
                    }}
                    required
                    maxLength={8192}
                    disabled={busy}
                  />
                  <FieldDescription>
                    {guidance.token} Git access uses this token over HTTPS.
                  </FieldDescription>
                </Field>
                <details
                  onInvalidCapture={(event) => {
                    event.currentTarget.open = true;
                  }}
                >
                  <summary className="w-fit cursor-pointer text-sm font-medium">
                    Instance and branch options
                  </summary>
                  <FieldGroup className="mt-4">
                    <Field data-disabled={busy}>
                      <FieldLabel htmlFor="repository-instance">
                        Instance URL (optional)
                      </FieldLabel>
                      <Input
                        id="repository-instance"
                        type="url"
                        placeholder={guidance.instance}
                        value={instanceUrl}
                        onChange={(event) => {
                          setInstanceUrl(event.target.value);
                          setVerified(undefined);
                        }}
                        maxLength={2048}
                        disabled={busy}
                        autoComplete="off"
                      />
                      <FieldDescription>
                        Set the base URL if the instance runs under a path, such
                        as https://git.example.com/gitlab. Leave blank for the
                        usual host.
                      </FieldDescription>
                    </Field>
                    <Field data-disabled={busy}>
                      <FieldLabel htmlFor="repository-branch">
                        Index branch (optional)
                      </FieldLabel>
                      <Input
                        id="repository-branch"
                        placeholder="Use the repository's default branch"
                        value={branch}
                        onChange={(event) => {
                          setBranch(event.target.value);
                          setVerified(undefined);
                        }}
                        maxLength={200}
                        disabled={busy}
                      />
                    </Field>
                  </FieldGroup>
                </details>
                <p className="text-sm text-muted-foreground">
                  This checks the bot identity and repository read access.{" "}
                  {forgeType === "github"
                    ? "You will receive the webhook URL, secret, and events after connecting."
                    : "Webhook configuration is checked when you connect."}
                </p>
              </FieldGroup>
            )}
            {step === 2 && (
              <FieldGroup>
                {verified && (
                  <Alert>
                    <AlertDescription>
                      Access checked for {verified.fullPath} as{" "}
                      {verified.botLogin}.
                    </AlertDescription>
                  </Alert>
                )}
                <AgentSelect
                  initialAgents={agents}
                  value={agentId}
                  onValueChange={setAgentId}
                  allowCreate={canManageAgents}
                  onCreated={(agent) =>
                    setAgents((current) => [
                      ...(current ?? []).filter((item) => item.id !== agent.id),
                      agent,
                    ])
                  }
                />
                <Field>
                  <FieldLabel htmlFor="repository-senders">
                    Who can request reviews?
                  </FieldLabel>
                  <Input
                    id="repository-senders"
                    placeholder="alice, bob"
                    autoComplete="off"
                    value={senders}
                    onChange={(event) => setSenders(event.target.value)}
                    required
                  />
                  <FieldDescription>
                    {guidance.label} usernames, separated by commas. Use a
                    different account from the bot to request reviews. Use *
                    only for a private repository.
                  </FieldDescription>
                </Field>
                {usesGithubApp ? (
                  <Alert>
                    <AlertDescription>
                      Webhooks are configured on {githubSelection?.appName} and
                      delivered to {selectedCallback}.
                    </AlertDescription>
                  </Alert>
                ) : (
                  <Field>
                    <FieldLabel htmlFor="repository-callback">
                      Webhook callback base URL
                    </FieldLabel>
                    <Input
                      id="repository-callback"
                      type="url"
                      pattern="https://.*"
                      placeholder="https://hooks.example.com"
                      value={callbackBase}
                      onChange={(event) => setCallbackBase(event.target.value)}
                      required
                    />
                    <FieldDescription>
                      The HTTPS address {guidance.label} can reach for razbor's
                      webhook ingress. A webhook secret is generated and shown
                      after connecting.
                    </FieldDescription>
                  </Field>
                )}
                <p className="text-sm text-muted-foreground">
                  {canManageRunners
                    ? "After connecting, you can assign an existing runner or register a new one here."
                    : "After connecting, ask a super admin to assign a ready runner to this repository."}{" "}
                  A runner is the host that executes reviews.
                </p>
              </FieldGroup>
            )}
            {step === 3 && (
              <>
                <dl className="grid gap-4 rounded-lg border bg-card p-5 sm:grid-cols-2">
                  {[
                    ["Forge", guidance.label],
                    ...(forgeType === "github"
                      ? [
                          [
                            "Connection",
                            usesGithubApp
                              ? (githubSelection?.appName ?? "GitHub App")
                              : "Manual webhook",
                          ],
                        ]
                      : []),
                    ["Repository", verified?.fullPath ?? repositoryUrl],
                    ["Bot account", verified?.botLogin],
                    ["Index branch", verified?.branch],
                    [
                      "AI reviewer",
                      agentId
                        ? (agents?.find((agent) => agent.id === agentId)
                            ?.model ?? "Selected agent")
                        : "Runner default",
                    ],
                    ["Permitted command senders", senders],
                    ["Webhook callback", selectedCallback],
                  ].map(([label, value]) => (
                    <div key={label} className="flex min-w-0 flex-col gap-1">
                      <dt className="text-sm text-muted-foreground">{label}</dt>
                      <dd className="break-words text-sm font-medium">
                        {value}
                      </dd>
                    </div>
                  ))}
                </dl>
                <Alert>
                  <AlertDescription>
                    {usesGithubApp
                      ? "Connecting uses your installed GitHub App and starts indexing."
                      : forgeType === "github"
                        ? "Connecting saves the bot token and starts indexing. Next, copy the webhook URL and generated secret into GitHub."
                        : "Connecting saves the bot token, configures the webhook, and starts indexing. You can then copy the generated webhook secret."}{" "}
                    {canManageRunners
                      ? "You can set up a runner after connecting."
                      : "A super admin manages runner assignments."}
                  </AlertDescription>
                </Alert>
              </>
            )}
            <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-5">
              <div className="flex gap-2">
                {step > 0 && (
                  <Button
                    type="button"
                    variant="outline"
                    disabled={busy}
                    onClick={goBack}
                  >
                    <ArrowLeft data-icon="inline-start" />
                    Back
                  </Button>
                )}
                {!busy && (
                  <Link
                    className={buttonVariants({ variant: "ghost" })}
                    href="/repos"
                    onClick={() => setAccessToken("")}
                  >
                    Cancel
                  </Link>
                )}
              </div>
              <Button
                type="submit"
                disabled={
                  busy ||
                  (step === 1 &&
                    (usesGithubApp
                      ? !githubSelection
                      : !repositoryUrl.trim() || !accessToken.trim()))
                }
              >
                {step === 3 && <GitBranch data-icon="inline-start" />}
                {busy
                  ? step === 1
                    ? "Checking access…"
                    : "Connecting…"
                  : step === 1
                    ? "Check access and continue"
                    : step === 3
                      ? "Connect repository"
                      : "Next"}
                {step !== 3 && <ArrowRight data-icon="inline-end" />}
              </Button>
            </div>
          </form>
        </section>
      </div>
    </main>
  );
}
