"use client";

import { useEffect, useState } from "react";

import type { getRepository, webhookView } from "@razbor/database";

import { usePoll } from "@web/lib/use-poll.js";
import { formatUtc } from "@web/lib/date.js";
import { Status } from "@web/components/status.js";
import { Button, buttonVariants } from "@web/components/ui/button.js";
import { Input } from "@web/components/ui/input.js";
import {
  Field,
  FieldGroup,
  FieldLabel,
  FieldDescription,
} from "@web/components/ui/field.js";
import {
  Alert,
  AlertTitle,
  AlertDescription,
} from "@web/components/ui/alert.js";
import { Skeleton } from "@web/components/ui/skeleton.js";

type Hook = Awaited<ReturnType<typeof webhookView>>;

/**
 * Describes the latest delivery with UTC time, or explains the next webhook setup step.
 */
function deliveryLabel(hook: Hook | undefined) {
  if (hook?.lastDelivery)
    return `Last delivery: ${hook.lastDelivery} · ${formatUtc(hook.lastDeliveryAt!)}`;
  return hook?.setup === "ready"
    ? "Awaiting first delivery"
    : "Enable authenticated comment requests for this repository.";
}

/**
 * Edits UI-owned webhook settings while refreshing connection and delivery state
 * without replacing an already-loaded draft.
 */
export function WebhookSettings({
  id,
  initialRepository,
  initialHook,
}: Readonly<{
  id: string;
  initialRepository?: Awaited<ReturnType<typeof getRepository>>;
  initialHook?: Hook;
}>) {
  const repo = usePoll<Awaited<ReturnType<typeof getRepository>>>(
    `/api/repositories/${id}`,
    initialRepository,
  );
  const hook = usePoll<Hook>(`/api/repositories/${id}/webhook`, initialHook);
  const [callback, setCallback] = useState(initialHook?.callbackBase ?? "");
  const [senders, setSenders] = useState(
    initialHook?.permittedSenders.join(", ") ?? "",
  );
  const [secret, setSecret] = useState("");
  const [enabled, setEnabled] = useState(initialHook?.enabled ?? true);
  const [loaded, setLoaded] = useState(initialHook !== undefined);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [generated, setGenerated] = useState("");
  useEffect(() => {
    if (hook.data !== undefined && !loaded) {
      if (hook.data) {
        setCallback(hook.data.callbackBase);
        setSenders(hook.data.permittedSenders.join(", "));
        setEnabled(hook.data.enabled);
      }
      setLoaded(true);
    }
  }, [hook.data, loaded]);
  const locked = webhookIsManaged(hook.data);
  const appManaged = hook.data?.mode === "github-app";
  const reconcileLabel =
    hook.data?.mode === "managed" ? "Reconcile webhook" : "Check connection";
  /**
   * Saves webhook settings or retries reconciliation, clearing submitted secrets and
   * exposing newly generated secrets only in local state.
   */
  async function save(reconcile = false) {
    setBusy(true);
    setMessage("");
    setGenerated("");
    try {
      const response = await fetch(`/api/repositories/${id}/webhook`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          reconcile
            ? { action: "reconcile" }
            : {
                enabled,
                ...(!appManaged ? { callback_base: callback } : {}),
                permitted_senders: senders
                  .split(",")
                  .map((s) => s.trim())
                  .filter(Boolean),
                ...(secret ? { signing_secret: secret } : {}),
              },
        ),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      hook.setData(result.webhook);
      setSecret("");
      setGenerated(result.generatedSecret ?? "");
      setMessage(
        `Settings saved. Hook setup: ${result.webhook?.setup ?? "pending"}.`,
      );
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Unable to save settings");
    } finally {
      setBusy(false);
    }
  }
  let webhookContent;
  if (!loaded && !hook.error) {
    webhookContent = <Skeleton className="h-64 w-full" />;
  } else if (!repo.data?.forgeId) {
    webhookContent = (
      <p className="text-sm text-muted-foreground">
        This repository has no forge instance. Configure its forge and
        repository selector in the application registry.
      </p>
    );
  } else {
    webhookContent = (
      <>
        <section className="flex min-w-0 flex-col gap-5 rounded-xl bg-muted/20 p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-semibold">
              {hook.data?.label ?? "Forge"} webhook
            </h2>
            <Status
              value={
                hook.data?.setup === "manual"
                  ? "awaiting delivery"
                  : (hook.data?.setup ?? "not configured")
              }
            />
          </div>
          <p className="text-sm text-muted-foreground">
            {deliveryLabel(hook.data)}
          </p>
          {locked && (
            <>
              <dl className="grid gap-4 text-sm sm:grid-cols-2">
                <div className="flex flex-col gap-1">
                  <dt className="text-muted-foreground">Review commands</dt>
                  <dd>{hook.data?.enabled ? "Enabled" : "Disabled"}</dd>
                </div>
                <div className="flex flex-col gap-1">
                  <dt className="text-muted-foreground">
                    Permitted commenters
                  </dt>
                  <dd>
                    {hook.data?.permittedSenders.includes("*")
                      ? "Everyone in the private repository"
                      : hook.data?.permittedSenders.join(", ")}
                  </dd>
                </div>
                <div className="flex flex-col gap-1 sm:col-span-2">
                  <dt className="text-muted-foreground">Callback URL</dt>
                  <dd className="break-all font-mono text-xs">
                    {hook.data?.callbackUrl}
                  </dd>
                </div>
              </dl>
              <p className="text-xs leading-relaxed text-muted-foreground">
                These webhook settings are managed by configuration “
                {hook.data?.managedBy}”. Update and apply that file to change
                them.
              </p>
              <div>
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => void save(true)}
                >
                  {busy ? "Checking…" : reconcileLabel}
                </Button>
              </div>
            </>
          )}
          {!locked && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void save();
              }}
            >
              <FieldGroup>
                {!appManaged && (
                  <Field>
                    <FieldLabel htmlFor="callback">
                      Reachable callback base URL
                    </FieldLabel>
                    <Input
                      id="callback"
                      type="url"
                      placeholder="https://hooks.example.com"
                      value={callback}
                      onChange={(e) => setCallback(e.target.value)}
                      disabled={busy}
                      required
                    />
                    <FieldDescription>
                      Forward only /webhooks/* from this HTTPS address to the
                      razbor app. Keep the management UI and API private.
                      {hook.data?.mode === "manual" &&
                        " After changing this address, update the Payload URL on GitHub and redeliver the ping."}
                    </FieldDescription>
                  </Field>
                )}
                <Field>
                  <FieldLabel htmlFor="senders">
                    Permitted command senders
                  </FieldLabel>
                  <Input
                    id="senders"
                    placeholder="alice, bob"
                    value={senders}
                    onChange={(e) => setSenders(e.target.value)}
                    disabled={busy}
                    required
                  />
                  <FieldDescription>
                    Forge usernames, separated by commas. Use * to allow any
                    commenter only while the repository is private.
                  </FieldDescription>
                </Field>
                {!appManaged && (
                  <Field>
                    <FieldLabel htmlFor="secret">Webhook secret</FieldLabel>
                    <Input
                      id="secret"
                      type="password"
                      autoComplete="new-password"
                      placeholder={
                        hook.data
                          ? "Saved securely · leave blank to keep"
                          : "Leave blank to generate once"
                      }
                      value={secret}
                      onChange={(e) => setSecret(e.target.value)}
                      disabled={busy}
                    />
                    <FieldDescription>
                      Separate from the forge access token. At least 32
                      characters when setting a value.
                      {hook.data?.mode === "manual" &&
                        " After changing it, update the Secret field on GitHub and redeliver the ping to verify the new configuration."}
                    </FieldDescription>
                  </Field>
                )}
                <Field orientation="horizontal">
                  <input
                    id="enabled"
                    type="checkbox"
                    checked={enabled}
                    onChange={(e) => setEnabled(e.target.checked)}
                    disabled={busy}
                  />
                  <FieldLabel htmlFor="enabled">
                    Accept review commands
                  </FieldLabel>
                </Field>
                <div className="flex flex-wrap gap-2">
                  <Button type="submit" disabled={busy}>
                    {busy ? "Saving…" : "Save webhook settings"}
                  </Button>
                  {hook.data && (
                    <Button
                      type="button"
                      variant="outline"
                      disabled={busy}
                      onClick={() => void save(true)}
                    >
                      {reconcileLabel}
                    </Button>
                  )}
                </div>
              </FieldGroup>
            </form>
          )}
        </section>
        {message && <output className="block text-sm">{message}</output>}
        {generated && (
          <Alert>
            <AlertTitle>Generated webhook secret</AlertTitle>
            <AlertDescription>
              <p>
                Saved in protected storage. Copy it now if you need to configure
                the hook manually.
              </p>
              <code className="break-all select-all">{generated}</code>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setGenerated("")}
              >
                Dismiss
              </Button>
            </AlertDescription>
          </Alert>
        )}
        <RemoteWebhookSetup hook={hook.data} />
      </>
    );
  }
  return (
    <section
      className="console-card grid min-w-0 gap-6 lg:grid-cols-[240px_minmax(0,1fr)]"
      aria-labelledby="webhook-settings-title"
    >
      <div className="flex flex-col gap-2">
        <h2 id="webhook-settings-title" className="text-base font-semibold">
          Review webhook
        </h2>
        <p className="text-sm leading-relaxed text-muted-foreground">
          Accept review requests from pull or merge request comments on your
          forge.
        </p>
      </div>
      <div className="flex min-w-0 flex-col gap-5">
        {(repo.error || hook.error) && (
          <Alert variant="destructive">
            <AlertDescription>
              Repository settings are unavailable. Retrying…
            </AlertDescription>
          </Alert>
        )}
        {webhookContent}
      </div>
    </section>
  );
}

/** Shows the setup instructions and ownership for the repository's webhook mode. */
export function RemoteWebhookSetup({
  hook,
}: Readonly<{ hook: Hook | undefined }>) {
  if (!hook) return null;
  if (hook.mode === "github-app")
    return (
      <Alert>
        <AlertTitle>Managed by your GitHub App</AlertTitle>
        <AlertDescription>
          <p>
            Your App delivers events to this razbor instance. Its webhook URL
            and signing secret are shared by its connected repositories.
          </p>
          <code className="block break-all">{hook.callbackUrl}</code>
          {hook.appUrl && (
            <a
              href={hook.appUrl}
              target="_blank"
              rel="noreferrer"
              className={buttonVariants({ variant: "outline", size: "sm" })}
            >
              Open GitHub App
            </a>
          )}
        </AlertDescription>
      </Alert>
    );
  return (
    <section className="console-card flex flex-col gap-3 text-sm">
      <h2 className="font-semibold">
        {hook.mode === "manual"
          ? "Add the webhook on GitHub"
          : "Remote hook setup"}
      </h2>
      <p className="text-muted-foreground">
        {hook.mode === "manual"
          ? "In your GitHub repository, open Settings → Webhooks → Add webhook. Use the payload URL below and the webhook secret shown when you connected the repository."
          : `If automatic setup is unavailable, add a ${hook.label} webhook in the repository settings with the callback below and the configured webhook secret.`}
        {hook.provider === "gitlab" &&
          " Use GitLab's Secret token field; this connection validates X-Gitlab-Token."}
      </p>
      <code className="block break-all rounded-md bg-muted p-3">
        {hook.callbackUrl}
      </code>
      <dl className="flex flex-col gap-2">
        <div>
          <dt className="font-medium">Content type</dt>
          <dd>{hook.manual.contentType}</dd>
        </div>
        <div>
          <dt className="font-medium">Select individual events</dt>
          <dd>{hook.manual.events.join(", ")}</dd>
        </div>
      </dl>
      {hook.mode === "manual" ? (
        <p className="text-muted-foreground">
          Keep SSL verification and Active enabled, then add the webhook. GitHub
          sends a signed ping; setup becomes ready when razbor receives it.
          Redeliver the ping from Recent Deliveries if needed. Your API token
          needs repository read and review/comment write access. If you lost the
          secret, set a new one in Webhook settings and on GitHub.
        </p>
      ) : (
        <p className="text-muted-foreground">
          The API token needs webhook management and review/comment write
          permission. Remote hook ID: {hook.remoteId ?? "not registered"}.
        </p>
      )}
    </section>
  );
}

/**
 * Identifies webhook records controlled outside the UI so their form can remain locked.
 */
function webhookIsManaged(hook: Hook | undefined) {
  return !!hook && hook.managedBy !== "ui";
}
