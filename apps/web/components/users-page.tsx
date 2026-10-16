"use client";

import { useState } from "react";
import { useRouter } from "next/navigation.js";
import {
  Info,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  UserCheck,
  Users,
  UserX,
  type LucideIcon,
} from "lucide-react";

import type { ConsoleUserView } from "@razbor/database";

import { ConsoleHero } from "@web/components/console-hero.js";
import { Alert, AlertDescription } from "@web/components/ui/alert.js";
import { Badge } from "@web/components/ui/badge.js";
import { Button } from "@web/components/ui/button.js";
import { Checkbox } from "@web/components/ui/checkbox.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@web/components/ui/dialog.js";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@web/components/ui/empty.js";
import {
  Field,
  FieldContent,
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
import { Skeleton } from "@web/components/ui/skeleton.js";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@web/components/ui/table.js";
import { usePoll } from "@web/lib/use-poll.js";

const roleOptions = [
  { value: "user", label: "User" },
  { value: "super_admin", label: "Super admin" },
];

/** Derives one or two visible initials from the displayed account name without exposing another identifier. */
function accountInitials(displayName: string) {
  const parts = displayName.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  const initials =
    parts.length === 1
      ? Array.from(parts[0]).slice(0, 2).join("")
      : parts
          .slice(0, 2)
          .map((part) => Array.from(part)[0])
          .join("");
  return initials.toLocaleUpperCase("en-US");
}

/** Presents a count from the saved account snapshot and aligns its explanation to the card's bottom. */
function UserSummaryCard({
  label,
  value,
  detail,
  icon: Icon,
  tone,
}: Readonly<{
  label: string;
  value: number | undefined;
  detail: string;
  icon: LucideIcon;
  tone: "success" | "info" | "findings" | "tokens";
}>) {
  return (
    <div className="flex min-h-24 min-w-0 gap-3 rounded-lg border bg-card p-4">
      <span
        className="overview-metric-icon flex size-9 shrink-0 items-center justify-center rounded-lg"
        data-tone={tone}
      >
        <Icon aria-hidden="true" className="size-5" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col">
        <h2 className="text-xs font-medium text-muted-foreground">{label}</h2>
        <p className="mt-1 break-all text-2xl font-semibold tracking-tight tabular-nums">
          {value?.toLocaleString("en-US") ?? "—"}
        </p>
        <p className="mt-auto pt-1 text-xs leading-relaxed text-muted-foreground">
          {detail}
        </p>
      </div>
    </div>
  );
}

/** Manages instance accounts while repository access belongs to personal and organization contexts. */
export function UsersPage({
  initialUsers,
  currentUserId,
  localEnabled,
}: Readonly<{
  initialUsers?: ConsoleUserView[];
  currentUserId: string;
  localEnabled: boolean;
}>) {
  const router = useRouter();
  const users = usePoll<ConsoleUserView[]>("/api/users", initialUsers);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<ConsoleUserView>();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<ConsoleUserView["role"]>("user");
  const [enabled, setEnabled] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [search, setSearch] = useState("");
  const externalAccount = editing?.authenticationMethod === "oidc";
  const superAdmins = users.data?.filter(
    (user) => user.role === "super_admin",
  ).length;
  const enabledAccounts = users.data?.filter((user) => user.enabled).length;
  const disabledAccounts = users.data?.filter((user) => !user.enabled).length;
  const query = search.trim().toLowerCase();
  const visibleUsers = users.data?.filter((user) =>
    `${user.displayName} ${user.username ?? ""} ${user.email ?? ""} ${user.role} ${user.role === "super_admin" ? "super admin" : "user"}`
      .toLowerCase()
      .includes(query),
  );

  /** Starts a new account or edits a snapshot without adopting subsequent polling changes. */
  function openAccount(user?: ConsoleUserView) {
    setEditing(user);
    setUsername(user?.username ?? "");
    setPassword("");
    setRole(user?.role ?? "user");
    setEnabled(user?.enabled ?? true);
    setError("");
    setMessage("");
    setOpen(true);
  }

  /** Discards dialog secrets when closing and prevents dismissal during a save. */
  function changeOpen(value: boolean) {
    if (busy) return;
    setOpen(value);
    setError("");
    if (!value) setPassword("");
  }

  /** Saves account settings and replaces its list snapshot only after server validation succeeds. */
  async function saveAccount() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch(
        editing ? `/api/users/${editing.id}` : "/api/users",
        {
          method: editing ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...(!editing ? { username: username.trim() } : { enabled }),
            ...(!externalAccount ? { role } : {}),
            ...(!externalAccount && password ? { password } : {}),
          }),
        },
      );
      const result = (await response.json()) as ConsoleUserView & {
        error?: string;
      };
      if (!response.ok || !result.id)
        throw new Error(result.error || "Unable to save account. Try again.");
      users.setData((current) =>
        current
          ? editing
            ? current.map((user) => (user.id === result.id ? result : user))
            : [...current, result]
          : [result],
      );
      setPassword("");
      setOpen(false);
      setMessage(
        editing
          ? `Account ${result.displayName} updated.`
          : `Account ${result.displayName} created.`,
      );
      router.refresh();
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "Unable to save account. Try again.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="console-hero-page users-page flex min-w-0 flex-col">
      <ConsoleHero
        id="users-title"
        eyebrow="Instance accounts"
        title="Users"
        description={
          localEnabled
            ? "Manage instance accounts and super admin access."
            : "Manage account status for identity provider users."
        }
      >
        <span className="console-hero-status">
          <Users aria-hidden="true" className="size-3.5 shrink-0" />
          <span className="tabular-nums">
            {users.data?.length ?? "—"}{" "}
            {users.data?.length === 1 ? "account" : "accounts"}
          </span>
        </span>
        <span className="console-hero-status">
          <RefreshCw aria-hidden="true" className="size-3.5 shrink-0" />
          Refreshes every 3 seconds
        </span>
      </ConsoleHero>
      <div className="console-container mt-6 mb-16 flex min-w-0 flex-col gap-5">
        <section
          aria-label="Account totals"
          className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4"
        >
          <UserSummaryCard
            label="Total accounts"
            value={users.data?.length}
            detail="Instance user accounts"
            icon={Users}
            tone="findings"
          />
          <UserSummaryCard
            label="Super admins"
            value={superAdmins}
            detail="Instance-wide administrator role"
            icon={ShieldCheck}
            tone="tokens"
          />
          <UserSummaryCard
            label="Enabled"
            value={enabledAccounts}
            detail="Account status enabled"
            icon={UserCheck}
            tone="success"
          />
          <UserSummaryCard
            label="Disabled"
            value={disabledAccounts}
            detail="Account status disabled"
            icon={UserX}
            tone="info"
          />
        </section>
        {users.error && (
          <Alert variant="destructive">
            <AlertDescription>
              Unable to refresh accounts. Retrying…
              {users.data &&
                " Showing the last successful snapshot; account totals and statuses may be outdated."}
            </AlertDescription>
          </Alert>
        )}
        {message && (
          <output className="text-sm text-muted-foreground" aria-live="polite">
            {message}
          </output>
        )}
        <div className="users-toolbar flex flex-wrap items-center justify-between gap-4">
          <Field className="w-full min-w-0 sm:max-w-md">
            <FieldLabel htmlFor="user-search" className="sr-only">
              Search accounts
            </FieldLabel>
            <div className="relative">
              <Search
                aria-hidden="true"
                className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
              />
              <Input
                id="user-search"
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search name, email or role…"
                disabled={!users.data}
                className="pl-9"
              />
            </div>
          </Field>
          {localEnabled && (
            <Button onClick={() => openAccount()}>
              <Plus data-icon="inline-start" />
              Add account
            </Button>
          )}
        </div>
        {!users.data ? (
          !users.error && (
            <div role="status">
              <span className="sr-only">Loading accounts…</span>
              <Skeleton className="h-64 w-full" />
            </div>
          )
        ) : visibleUsers?.length ? (
          <div className="users-table overflow-hidden rounded-lg border bg-card">
            <Table aria-label="Instance accounts">
              <TableHeader>
                <TableRow>
                  <TableHead className="users-account-cell">Account</TableHead>
                  <TableHead className="users-role-cell">Role</TableHead>
                  <TableHead className="users-status-cell">Status</TableHead>
                  <TableHead className="users-actions-cell">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visibleUsers.map((user) => (
                  <TableRow key={user.id}>
                    <TableCell
                      className="users-account-cell"
                      data-label="Account"
                    >
                      <div className="flex min-w-0 items-start gap-3">
                        <span
                          aria-hidden="true"
                          className="flex size-10 shrink-0 items-center justify-center rounded-full border bg-muted/40 text-xs font-semibold text-muted-foreground"
                        >
                          {accountInitials(user.displayName)}
                        </span>
                        <div className="flex min-w-0 flex-col gap-1.5">
                          <div className="flex min-w-0 flex-wrap items-center gap-2">
                            <span className="break-all font-semibold">
                              {user.displayName}
                            </span>
                            {user.id === currentUserId && (
                              <Badge
                                variant="outline"
                                className="h-auto min-h-5 max-w-full whitespace-normal"
                              >
                                You
                              </Badge>
                            )}
                          </div>
                          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                            {user.username &&
                              user.username !== user.displayName && (
                                <span className="break-all">
                                  @{user.username}
                                </span>
                              )}
                            {user.email && user.email !== user.displayName && (
                              <span className="break-all">{user.email}</span>
                            )}
                            <Badge
                              variant="secondary"
                              className="h-auto min-h-5 max-w-full whitespace-normal"
                            >
                              {user.authenticationMethod === "oidc"
                                ? "OIDC"
                                : "Local"}
                            </Badge>
                          </div>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell className="users-role-cell" data-label="Role">
                      <Badge
                        variant={
                          user.role === "super_admin" ? "warning" : "outline"
                        }
                        className="h-auto min-h-5 max-w-full whitespace-normal"
                      >
                        {user.role === "super_admin" && (
                          <ShieldCheck data-icon="inline-start" />
                        )}
                        {user.role === "super_admin" ? "Super admin" : "User"}
                      </Badge>
                    </TableCell>
                    <TableCell
                      className="users-status-cell"
                      data-label="Status"
                    >
                      <div className="flex flex-wrap gap-2">
                        <Badge
                          variant={user.enabled ? "success" : "secondary"}
                          className="h-auto min-h-5 max-w-full whitespace-normal"
                        >
                          {user.enabled ? "Enabled" : "Disabled"}
                        </Badge>
                        {user.mustChangePassword && (
                          <Badge
                            variant="secondary"
                            className="h-auto min-h-5 max-w-full whitespace-normal"
                          >
                            Password change required
                          </Badge>
                        )}
                      </div>
                    </TableCell>
                    <TableCell
                      className="users-actions-cell"
                      data-label="Actions"
                    >
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => openAccount(user)}
                        aria-label={`Manage ${user.displayName}`}
                      >
                        Manage
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : (
          <Empty className="border bg-card">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                {query ? <Search /> : <Users />}
              </EmptyMedia>
              <EmptyTitle>
                {query ? "No matching accounts" : "No accounts"}
              </EmptyTitle>
              <EmptyDescription>
                {query
                  ? "Try another name, username, email or account role."
                  : localEnabled
                    ? "Add an account to give someone access to repository reviews."
                    : "Accounts appear after their first identity provider sign-in."}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
        <section
          aria-labelledby="about-users"
          className="flex items-start gap-3 rounded-lg border bg-card p-5"
        >
          <Info
            aria-hidden="true"
            className="mt-0.5 size-5 shrink-0 text-primary"
          />
          <div>
            <h2 id="about-users" className="text-lg font-semibold">
              About users
            </h2>
            <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
              Account roles apply to the instance. Users manage their personal
              resources and can create or join organizations. Organization
              admins manage their own members and repository access.
            </p>
            {!localEnabled && (
              <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                Users join through your identity provider. Their instance roles
                are mapped from provider groups at sign-in; account status is
                managed here.
              </p>
            )}
          </div>
        </section>
      </div>
      <Dialog open={open} onOpenChange={changeOpen}>
        <DialogContent
          className="max-h-[90dvh] overflow-y-auto sm:max-w-lg"
          showCloseButton={!busy}
        >
          <DialogHeader>
            <DialogTitle>
              {editing ? `Manage ${editing.displayName}` : "Add account"}
            </DialogTitle>
            <DialogDescription>
              {externalAccount
                ? "Manage account status. Sign-in and instance roles are managed by your identity provider."
                : editing
                  ? localEnabled
                    ? "Update the account's role and access, or set a temporary password."
                    : "Update the account's role and access."
                  : "Create an account with an initial password. They must change it when they first sign in."}
            </DialogDescription>
          </DialogHeader>
          <form
            className="flex flex-col gap-4"
            aria-busy={busy}
            onSubmit={(event) => {
              event.preventDefault();
              void saveAccount();
            }}
          >
            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            <FieldGroup>
              {!editing && (
                <Field data-disabled={busy}>
                  <FieldLabel htmlFor="account-username">Username</FieldLabel>
                  <Input
                    id="account-username"
                    autoComplete="off"
                    autoCapitalize="none"
                    spellCheck={false}
                    value={username}
                    onChange={(event) => setUsername(event.target.value)}
                    required
                    minLength={3}
                    maxLength={64}
                    disabled={busy}
                  />
                </Field>
              )}
              {externalAccount ? (
                <Field>
                  <FieldLabel>Role</FieldLabel>
                  <p className="text-sm">
                    {role === "super_admin" ? "Super admin" : "User"}
                  </p>
                  <FieldDescription>
                    Mapped from identity provider groups at sign-in.
                  </FieldDescription>
                </Field>
              ) : (
                <Field data-disabled={busy || editing?.id === currentUserId}>
                  <FieldLabel htmlFor="account-role">Role</FieldLabel>
                  <Select
                    items={roleOptions}
                    value={role}
                    onValueChange={(value) => {
                      if (value === "user" || value === "super_admin")
                        setRole(value);
                    }}
                    disabled={busy || editing?.id === currentUserId}
                  >
                    <SelectTrigger id="account-role" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent alignItemWithTrigger={false}>
                      <SelectGroup>
                        {roleOptions.map((option) => (
                          <SelectItem key={option.value} value={option.value}>
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                  <FieldDescription>
                    {role === "super_admin"
                      ? "Super admins manage users, OAuth configuration, and runners, and can access every account context for support."
                      : "Users manage their personal resources and can create or join organizations."}
                    {editing?.id === currentUserId &&
                      " Another administrator can change your role."}
                  </FieldDescription>
                </Field>
              )}
              {!externalAccount && localEnabled && (
                <Field data-disabled={busy}>
                  <FieldLabel htmlFor="account-password">
                    {editing ? "Reset password (optional)" : "Initial password"}
                  </FieldLabel>
                  <Input
                    id="account-password"
                    type="password"
                    autoComplete="new-password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    required={!editing}
                    minLength={12}
                    maxLength={1024}
                    disabled={busy}
                    aria-describedby="account-password-hint"
                  />
                  <FieldDescription id="account-password-hint">
                    {editing
                      ? "Leave blank to keep the current password. A reset signs them out and requires a password change at their next login."
                      : "Use at least 12 characters and share it with the account owner."}
                  </FieldDescription>
                </Field>
              )}
              {editing && (
                <Field
                  orientation="horizontal"
                  data-disabled={busy || editing.id === currentUserId}
                >
                  <Checkbox
                    id="account-enabled"
                    checked={enabled}
                    disabled={busy || editing.id === currentUserId}
                    onCheckedChange={setEnabled}
                  />
                  <FieldContent>
                    <FieldLabel htmlFor="account-enabled">
                      Account enabled
                    </FieldLabel>
                    <FieldDescription>
                      {editing.id === currentUserId
                        ? "Your current account stays enabled."
                        : "Disabled accounts cannot sign in, and their existing sessions end."}
                    </FieldDescription>
                  </FieldContent>
                </Field>
              )}
            </FieldGroup>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => changeOpen(false)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={
                  busy ||
                  (!editing && (!username.trim() || password.length < 12)) ||
                  Boolean(password && password.length < 12)
                }
              >
                <Users data-icon="inline-start" />
                {busy ? "Saving…" : editing ? "Save changes" : "Create account"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </main>
  );
}
