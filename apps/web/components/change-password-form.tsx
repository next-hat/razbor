"use client";

import Link from "next/link.js";
import { useRouter } from "next/navigation.js";
import { useState } from "react";
import { KeyRound, ShieldCheck, UserRound } from "lucide-react";

import { ConsoleHero } from "@web/components/console-hero.js";
import { Alert, AlertDescription } from "@web/components/ui/alert.js";
import { Button } from "@web/components/ui/button.js";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@web/components/ui/field.js";
import { Input } from "@web/components/ui/input.js";

/** Replaces an initial or existing password before continuing to the authenticated console. */
export function ChangePasswordForm({
  username,
  required,
}: Readonly<{ username: string; required: boolean }>) {
  const router = useRouter();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const mismatch = Boolean(confirmation && confirmation !== newPassword);

  /** Verifies confirmation locally, saves the replacement, and refreshes the current session. */
  async function changePassword() {
    if (busy || mismatch) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/auth/password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      const result = (await response.json()) as { error?: string };
      if (!response.ok)
        throw new Error(
          result.error || "Unable to change password. Try again.",
        );
      setNewPassword("");
      setConfirmation("");
      router.replace("/");
      router.refresh();
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "Unable to change password. Try again.",
      );
    } finally {
      setCurrentPassword("");
      setBusy(false);
    }
  }

  return (
    <main className="console-hero-page flex min-w-0 flex-col">
      <ConsoleHero
        id="password-title"
        eyebrow="Account security"
        title={required ? "Set password" : "Change password"}
        includeOverview={false}
        description={
          required
            ? "Replace your initial password to continue to your workspace."
            : "Choose a new password for your razbor account."
        }
      >
        <span className="console-hero-status max-w-full">
          <UserRound className="size-4 shrink-0" aria-hidden="true" />
          <span className="min-w-0 break-all">{username}</span>
        </span>
        {required && (
          <span className="console-hero-status">
            <KeyRound className="size-4" aria-hidden="true" />
            Password change required
          </span>
        )}
      </ConsoleHero>
      <div className="console-container mt-6 mb-16 grid min-w-0 items-start gap-5 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <section
          className="console-card flex w-full flex-col gap-4"
          aria-labelledby="password-form-title"
        >
          <div className="flex items-start gap-3">
            <span
              className="overview-metric-icon flex size-9 shrink-0 items-center justify-center rounded-lg"
              data-tone="findings"
            >
              <KeyRound className="size-5" aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <h2 id="password-form-title" className="text-base font-semibold">
                Update credentials
              </h2>
              <p className="mt-1 text-sm leading-6 text-muted-foreground">
                Enter your current password and confirm its replacement.
              </p>
            </div>
          </div>
          <form
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              void changePassword();
            }}
            aria-busy={busy}
          >
            <input
              type="hidden"
              name="username"
              autoComplete="username"
              value={username}
            />
            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            <FieldGroup>
              <Field data-disabled={busy}>
                <FieldLabel htmlFor="current-password">
                  Current password
                </FieldLabel>
                <Input
                  id="current-password"
                  name="currentPassword"
                  type="password"
                  autoComplete="current-password"
                  value={currentPassword}
                  onChange={(event) => setCurrentPassword(event.target.value)}
                  required
                  maxLength={1024}
                  disabled={busy}
                  autoFocus
                />
              </Field>
              <Field data-disabled={busy}>
                <FieldLabel htmlFor="new-password">New password</FieldLabel>
                <Input
                  id="new-password"
                  name="newPassword"
                  type="password"
                  autoComplete="new-password"
                  value={newPassword}
                  onChange={(event) => setNewPassword(event.target.value)}
                  required
                  minLength={12}
                  maxLength={1024}
                  disabled={busy}
                  aria-describedby="new-password-hint"
                />
                <FieldDescription id="new-password-hint">
                  Use at least 12 characters.
                </FieldDescription>
              </Field>
              <Field data-disabled={busy} data-invalid={mismatch}>
                <FieldLabel htmlFor="confirm-password">
                  Confirm new password
                </FieldLabel>
                <Input
                  id="confirm-password"
                  name="confirmation"
                  type="password"
                  autoComplete="new-password"
                  value={confirmation}
                  onChange={(event) => setConfirmation(event.target.value)}
                  required
                  minLength={12}
                  maxLength={1024}
                  disabled={busy}
                  aria-invalid={mismatch}
                  aria-describedby={mismatch ? "password-mismatch" : undefined}
                />
                {mismatch && (
                  <FieldError id="password-mismatch">
                    Passwords do not match.
                  </FieldError>
                )}
              </Field>
            </FieldGroup>
            <Button
              className="self-start"
              type="submit"
              disabled={
                busy ||
                !currentPassword ||
                newPassword.length < 12 ||
                !confirmation ||
                mismatch
              }
            >
              {busy
                ? "Saving password…"
                : required
                  ? "Save password and continue"
                  : "Save password"}
            </Button>
            {!required && (
              <Link
                href="/"
                className="text-center text-sm text-muted-foreground underline underline-offset-4"
              >
                Cancel
              </Link>
            )}
          </form>
        </section>
        <aside
          className="console-card flex flex-col gap-3"
          aria-labelledby="password-help-title"
        >
          <ShieldCheck className="size-5 text-info" aria-hidden="true" />
          <h2 id="password-help-title" className="text-base font-semibold">
            Password guidance
          </h2>
          <p className="text-sm leading-6 text-muted-foreground">
            Use at least 12 characters and choose a password you do not use for
            other accounts.
          </p>
          <p className="text-xs leading-5 text-muted-foreground">
            Your current password is required to save this change.
          </p>
        </aside>
      </div>
    </main>
  );
}
