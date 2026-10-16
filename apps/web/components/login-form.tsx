"use client";

import { useState } from "react";
import { useRouter } from "next/navigation.js";
import { ArrowRight, KeyRound, ShieldCheck } from "lucide-react";

import type { ConsoleUserView } from "@razbor/database";

import { ConsoleHero } from "@web/components/console-hero.js";
import { Alert, AlertDescription } from "@web/components/ui/alert.js";
import { Button } from "@web/components/ui/button.js";
import { Field, FieldGroup, FieldLabel } from "@web/components/ui/field.js";
import { Input } from "@web/components/ui/input.js";

/** Offers configured sign-in methods while retaining safe OIDC failures and local credential handling. */
export function LoginForm({
  localEnabled,
  oidcEnabled,
  identityError,
  signedOut,
}: Readonly<{
  localEnabled: boolean;
  oidcEnabled: boolean;
  identityError: boolean;
  signedOut: boolean;
}>) {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(
    identityError
      ? "Unable to sign in with your identity provider. Try again or contact your administrator."
      : "",
  );

  /** Exchanges credentials for a session without retaining the password after the request. */
  async function signIn() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: username.trim(), password }),
      });
      const result = (await response.json()) as {
        user?: ConsoleUserView;
        error?: string;
      };
      if (!response.ok || !result.user)
        throw new Error(result.error || "Unable to sign in. Try again.");
      router.replace(result.user.mustChangePassword ? "/change-password" : "/");
      router.refresh();
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "Unable to sign in. Try again.",
      );
    } finally {
      setPassword("");
      setBusy(false);
    }
  }

  return (
    <main className="console-hero-page flex min-w-0 flex-col">
      <ConsoleHero
        id="sign-in-title"
        eyebrow="Private workspace"
        title="Sign in"
        includeOverview={false}
        description="Access your repository reviews, findings, and review history."
      >
        {oidcEnabled && (
          <span className="console-hero-status">
            <ShieldCheck className="size-4" aria-hidden="true" />
            Identity provider
          </span>
        )}
        {localEnabled && (
          <span className="console-hero-status">
            <KeyRound className="size-4" aria-hidden="true" />
            Account credentials
          </span>
        )}
      </ConsoleHero>
      <div className="console-container mt-6 mb-16 grid min-w-0 items-start gap-5 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <section
          className="console-card flex w-full flex-col gap-4"
          aria-labelledby="workspace-access-title"
        >
          <div className="flex items-start gap-3">
            <span
              className="overview-metric-icon flex size-9 shrink-0 items-center justify-center rounded-lg"
              data-tone="findings"
            >
              <KeyRound className="size-5" aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <h2
                id="workspace-access-title"
                className="text-base font-semibold"
              >
                Workspace access
              </h2>
              <p className="mt-1 text-sm leading-6 text-muted-foreground">
                {oidcEnabled
                  ? "Use your identity provider or the sign-in method configured by your administrator."
                  : "Use the account your administrator created for you."}
              </p>
            </div>
          </div>
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          {signedOut && (
            <Alert>
              <AlertDescription>
                You are signed out of razbor.
                {oidcEnabled &&
                  " Your identity provider session may still be active."}
              </AlertDescription>
            </Alert>
          )}
          {oidcEnabled && (
            <Button
              className="self-start"
              render={<a href="/api/auth/oidc/start" />}
              nativeButton={false}
            >
              Continue with identity provider
              <ArrowRight data-icon="inline-end" />
            </Button>
          )}
          {localEnabled && (
            <form
              className="flex flex-col gap-4"
              onSubmit={(event) => {
                event.preventDefault();
                void signIn();
              }}
              aria-busy={busy}
            >
              <FieldGroup>
                <Field data-disabled={busy}>
                  <FieldLabel htmlFor="login-username">Username</FieldLabel>
                  <Input
                    id="login-username"
                    name="username"
                    autoComplete="username"
                    autoCapitalize="none"
                    spellCheck={false}
                    value={username}
                    onChange={(event) => setUsername(event.target.value)}
                    required
                    maxLength={64}
                    disabled={busy}
                    autoFocus
                  />
                </Field>
                <Field data-disabled={busy}>
                  <FieldLabel htmlFor="login-password">Password</FieldLabel>
                  <Input
                    id="login-password"
                    name="password"
                    type="password"
                    autoComplete="current-password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    required
                    maxLength={1024}
                    disabled={busy}
                  />
                </Field>
              </FieldGroup>
              <Button
                className="self-start"
                type="submit"
                disabled={busy || !username.trim() || !password}
              >
                {busy
                  ? "Signing in…"
                  : oidcEnabled
                    ? "Sign in with password"
                    : "Sign in"}
                <ArrowRight data-icon="inline-end" />
              </Button>
            </form>
          )}
        </section>
        <aside
          className="console-card flex flex-col gap-3"
          aria-labelledby="account-help-title"
        >
          <ShieldCheck className="size-5 text-info" aria-hidden="true" />
          <h2 id="account-help-title" className="text-base font-semibold">
            Account access
          </h2>
          <p className="text-sm leading-6 text-muted-foreground">
            {oidcEnabled
              ? "Your identity provider manages your sign-in. Contact your administrator for repository access."
              : "Need an account or a password reset? Contact your administrator."}
          </p>
        </aside>
      </div>
    </main>
  );
}
