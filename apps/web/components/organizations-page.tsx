"use client";

import { useState } from "react";
import { useRouter } from "next/navigation.js";
import { Building2, Plus, UserPlus } from "lucide-react";

import type {
  ContextView,
  OrganizationInvitationView,
  OrganizationMemberView,
  listRepositories,
} from "@razbor/database";

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
  FieldLegend,
  FieldSet,
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

type OrganizationRole = OrganizationMemberView["role"];

type OrganizationSnapshot = {
  members: OrganizationMemberView[];
  invitations: OrganizationInvitationView[];
  repositories: Awaited<ReturnType<typeof listRepositories>>;
};

type ContextSnapshot = {
  contexts: ContextView[];
  currentContext: ContextView;
  invitations: OrganizationInvitationView[];
};

const roles = [
  { value: "member", label: "Member" },
  { value: "moderator", label: "Moderator" },
  { value: "admin", label: "Admin" },
];

/** Sends one organization mutation and displays only the API's safe public error message. */
async function mutate(url: string, method: string, body?: unknown) {
  const response = await fetch(url, {
    method,
    ...(body !== undefined
      ? {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      : {}),
  });
  if (response.status === 204) return {};
  const result = (await response.json()) as {
    error?: string;
    id?: string;
    context?: ContextView;
  };
  if (!response.ok)
    throw new Error(result.error || "Unable to save changes. Try again.");
  return result;
}

/** Explains the role's effective repository access rather than suggesting selected grants restrict managers. */
function roleDescription(role: OrganizationRole) {
  if (role === "admin")
    return "Admins manage all organization resources, invitations, members, and roles. They can access every repository.";
  if (role === "moderator")
    return "Moderators manage repositories, skills, MCP servers, and members' repository access. They can access every repository.";
  return "Members can view PRs and review history and trigger reviews only for selected repositories. No repositories are selected by default.";
}

/** Formats the number of explicit repository grants consistently in member and invitation summaries. */
function repositoryCount(count: number) {
  return `${count} ${count === 1 ? "repository" : "repositories"}`;
}

/** Builds accessible, explicit repository grants using the existing organization repository catalog. */
function RepositoryChoices({
  repositories,
  selected,
  onChange,
  disabled,
}: Readonly<{
  repositories: OrganizationSnapshot["repositories"];
  selected: string[];
  onChange: (ids: string[]) => void;
  disabled: boolean;
}>) {
  return (
    <FieldSet disabled={disabled}>
      <FieldLegend>Repository access</FieldLegend>
      <FieldDescription>
        Choose the repositories this member can view and request reviews for.
      </FieldDescription>
      {repositories.length ? (
        <FieldGroup className="max-h-60 overflow-y-auto">
          {repositories.map((repository) => (
            <Field
              key={repository.id}
              orientation="horizontal"
              data-disabled={disabled}
            >
              <Checkbox
                id={`organization-repository-${repository.id}`}
                checked={selected.includes(repository.id)}
                disabled={disabled}
                onCheckedChange={(checked) =>
                  onChange(
                    checked
                      ? [...selected, repository.id]
                      : selected.filter((id) => id !== repository.id),
                  )
                }
              />
              <FieldContent>
                <FieldLabel
                  htmlFor={`organization-repository-${repository.id}`}
                >
                  {repository.metadata?.fullPath ??
                    repository.selector ??
                    repository.configKey}
                </FieldLabel>
              </FieldContent>
            </Field>
          ))}
        </FieldGroup>
      ) : (
        <FieldDescription>
          No organization repositories yet. Access can be granted after adding a
          repository.
        </FieldDescription>
      )}
    </FieldSet>
  );
}

/** Manages the current organization's invitations, roles, and direct repository grants without introducing groups. */
function OrganizationManagement({
  context,
  currentUserId,
  initialData,
  canManageMembers,
}: Readonly<{
  context: ContextView;
  currentUserId: string;
  initialData?: OrganizationSnapshot;
  canManageMembers: boolean;
}>) {
  const router = useRouter();
  const snapshot = usePoll<OrganizationSnapshot>(
    `/api/organizations/${context.id}`,
    initialData,
    5000,
  );
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<OrganizationMemberView>();
  const [removing, setRemoving] = useState<OrganizationMemberView>();
  const [userId, setUserId] = useState("");
  const [role, setRole] = useState<OrganizationRole>("member");
  const [repositoryIds, setRepositoryIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  /** Opens a member snapshot or a zero-access invitation without inheriting previous selections. */
  function openMember(member?: OrganizationMemberView) {
    setEditing(member);
    setUserId("");
    setRole(member?.role ?? "member");
    setRepositoryIds(member?.repositoryIds ?? []);
    setError("");
    setOpen(true);
  }

  /** Starts a manager's downgrade with zero grants instead of copying implicit access to every repository. */
  function selectRole(value: string | null) {
    if (value !== "admin" && value !== "moderator" && value !== "member")
      return;
    if (value === "member" && role !== "member") setRepositoryIds([]);
    setRole(value);
  }

  /** Refreshes management data after a confirmed mutation and updates server-rendered navigation. */
  async function refresh() {
    const response = await fetch(`/api/organizations/${context.id}`, {
      cache: "no-store",
    });
    if (response.ok) snapshot.setData(await response.json());
    router.refresh();
  }

  /** Saves roles only for admins and repository grants only for ordinary members. */
  async function saveMember() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const base = `/api/organizations/${context.id}`;
      if (editing) {
        if (canManageMembers)
          await mutate(`${base}/members/${editing.id}`, "PATCH", {
            role,
            ...(role === "member" ? { repositoryIds } : {}),
          });
        else if (role === "member")
          await mutate(`${base}/members/${editing.id}/repositories`, "PUT", {
            repositoryIds,
          });
        setMessage(`Access for ${editing.displayName} updated.`);
      } else {
        await mutate(`${base}/invitations`, "POST", {
          userId: userId.trim(),
          role,
          repositoryIds: role === "member" ? repositoryIds : [],
        });
        setMessage(
          "Invitation sent. Access starts after the recipient accepts.",
        );
      }
      setOpen(false);
      await refresh();
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "Unable to save changes. Try again.",
      );
    } finally {
      setBusy(false);
    }
  }

  /** Removes organization membership and every associated repository grant after explicit dialog confirmation. */
  async function removeMember() {
    if (!removing || busy) return;
    setBusy(true);
    setError("");
    try {
      await mutate(
        `/api/organizations/${context.id}/members/${removing.id}`,
        "DELETE",
      );
      setMessage(`${removing.displayName} removed from the organization.`);
      setRemoving(undefined);
      await refresh();
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "Unable to remove member. Try again.",
      );
    } finally {
      setBusy(false);
    }
  }

  /** Revokes an unaccepted invitation so its saved repository grants can no longer activate. */
  async function revokeInvitation(invitation: OrganizationInvitationView) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await mutate(
        `/api/organizations/${context.id}/invitations/${invitation.id}`,
        "DELETE",
      );
      setMessage(`Invitation for ${invitation.displayName} revoked.`);
      await refresh();
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "Unable to revoke invitation. Try again.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      className="flex flex-col gap-4"
      aria-labelledby="organization-members"
    >
      <div className="flex flex-col gap-4 sm:flex-row sm:flex-wrap sm:items-start sm:justify-between">
        <div className="min-w-0 flex-1">
          <h2
            id="organization-members"
            className="break-words text-xl font-semibold tracking-tight"
          >
            {context.name} members
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {canManageMembers
              ? "Invite members, assign roles, and choose repository access."
              : "Manage repository access for organization members."}
          </p>
        </div>
        {canManageMembers && (
          <Button
            onClick={() => openMember()}
            disabled={!snapshot.data || busy}
          >
            <UserPlus data-icon="inline-start" />
            Invite member
          </Button>
        )}
      </div>
      {snapshot.error && (
        <Alert variant="destructive">
          <AlertDescription>
            Unable to refresh organization access. Retrying…
          </AlertDescription>
        </Alert>
      )}
      {error && !open && !removing && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {message && (
        <output aria-live="polite" className="text-sm text-muted-foreground">
          {message}
        </output>
      )}
      {!snapshot.data ? (
        <Skeleton className="h-36 w-full" />
      ) : (
        <div className="console-table overflow-hidden rounded-xl border bg-card">
          <Table aria-label={`${context.name} members`}>
            <colgroup>
              <col className="w-[34%]" />
              <col className="w-[14%]" />
              <col className="w-[22%]" />
              <col className="w-[30%]" />
            </colgroup>
            <TableHeader>
              <TableRow>
                <TableHead>Member</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Repository access</TableHead>
                <TableHead className="text-right">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {snapshot.data.members.map((member) => (
                <TableRow key={member.id}>
                  <TableCell
                    className="console-table-primary"
                    data-label="Member"
                  >
                    <span className="break-words font-semibold">
                      {member.displayName}
                    </span>
                    {member.id === currentUserId && (
                      <span className="ml-2 text-xs text-muted-foreground">
                        You
                      </span>
                    )}
                    {member.username && (
                      <p className="mt-1 text-xs text-muted-foreground">
                        {member.username}
                      </p>
                    )}
                  </TableCell>
                  <TableCell data-label="Role">
                    <Badge variant="outline">
                      {
                        roles.find((option) => option.value === member.role)
                          ?.label
                      }
                    </Badge>
                  </TableCell>
                  <TableCell data-label="Repository access">
                    {member.role === "member"
                      ? repositoryCount(member.repositoryIds.length)
                      : "All repositories"}
                  </TableCell>
                  <TableCell
                    className="console-table-actions"
                    data-label="Actions"
                  >
                    <div className="flex flex-wrap gap-2 lg:justify-end">
                      {(canManageMembers || member.role === "member") && (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={busy}
                          onClick={() => openMember(member)}
                          aria-label={`Manage access for ${member.displayName}`}
                        >
                          Manage access
                        </Button>
                      )}
                      {canManageMembers && (
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={busy}
                          onClick={() => {
                            setError("");
                            setRemoving(member);
                          }}
                          aria-label={`Remove ${member.displayName}`}
                        >
                          Remove
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      {canManageMembers && snapshot.data && (
        <section
          className="mt-2 flex min-w-0 flex-col gap-4"
          aria-labelledby="sent-invitations"
        >
          <h3 id="sent-invitations" className="text-base font-semibold">
            Invitations
          </h3>
          {snapshot.data.invitations.length ? (
            <div className="console-table overflow-hidden rounded-xl border bg-card">
              <Table aria-label={`${context.name} invitations`}>
                <colgroup>
                  <col className="w-[28%]" />
                  <col className="w-[14%]" />
                  <col className="w-[24%]" />
                  <col className="w-[16%]" />
                  <col className="w-[18%]" />
                </colgroup>
                <TableHeader>
                  <TableRow>
                    <TableHead>Account</TableHead>
                    <TableHead>Role</TableHead>
                    <TableHead>Repository access</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">
                      <span className="sr-only">Actions</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {snapshot.data.invitations.map((invitation) => (
                    <TableRow key={invitation.id}>
                      <TableCell
                        className="console-table-primary"
                        data-label="Account"
                      >
                        <span className="font-semibold">
                          {invitation.displayName}
                        </span>
                      </TableCell>
                      <TableCell data-label="Role">
                        {
                          roles.find(
                            (option) => option.value === invitation.role,
                          )?.label
                        }
                      </TableCell>
                      <TableCell data-label="Repository access">
                        {invitation.role === "member"
                          ? repositoryCount(invitation.repositoryIds.length)
                          : "All repositories"}
                      </TableCell>
                      <TableCell data-label="Status">
                        <Badge variant="outline">{invitation.status}</Badge>
                      </TableCell>
                      <TableCell
                        className="console-table-actions lg:text-right"
                        data-label="Actions"
                      >
                        {invitation.status === "pending" && (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={busy}
                            onClick={() => void revokeInvitation(invitation)}
                          >
                            Revoke
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              No invitations sent yet.
            </p>
          )}
        </section>
      )}
      <Dialog
        open={open}
        onOpenChange={(value) => {
          if (!busy) {
            setOpen(value);
            setError("");
          }
        }}
      >
        <DialogContent
          className="max-h-[90dvh] overflow-y-auto sm:max-w-lg"
          showCloseButton={!busy}
        >
          <DialogHeader>
            <DialogTitle>
              {editing
                ? `Access for ${editing.displayName}`
                : `Invite to ${context.name}`}
            </DialogTitle>
            <DialogDescription>
              {editing
                ? "Changes apply to this organization only."
                : "Invite an existing Razbor account. Repository access begins when they accept."}
            </DialogDescription>
          </DialogHeader>
          <form
            className="flex flex-col gap-4"
            aria-busy={busy}
            onSubmit={(event) => {
              event.preventDefault();
              void saveMember();
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
                  <FieldLabel htmlFor="invitation-user">
                    Username or account ID
                  </FieldLabel>
                  <Input
                    id="invitation-user"
                    value={userId}
                    onChange={(event) => setUserId(event.target.value)}
                    autoCapitalize="none"
                    autoComplete="off"
                    spellCheck={false}
                    required
                    disabled={busy}
                  />
                </Field>
              )}
              {canManageMembers ? (
                <Field data-disabled={busy}>
                  <FieldLabel htmlFor="organization-role">
                    Organization role
                  </FieldLabel>
                  <Select
                    items={roles}
                    value={role}
                    disabled={busy}
                    onValueChange={selectRole}
                  >
                    <SelectTrigger id="organization-role" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent alignItemWithTrigger={false}>
                      <SelectGroup>
                        {roles.map((option) => (
                          <SelectItem key={option.value} value={option.value}>
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                  <FieldDescription>{roleDescription(role)}</FieldDescription>
                </Field>
              ) : (
                <FieldDescription>{roleDescription(role)}</FieldDescription>
              )}
              {role === "member" && snapshot.data && (
                <RepositoryChoices
                  repositories={snapshot.data.repositories}
                  selected={repositoryIds}
                  onChange={setRepositoryIds}
                  disabled={busy}
                />
              )}
            </FieldGroup>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => {
                  setOpen(false);
                  setError("");
                }}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={
                  busy || !snapshot.data || (!editing && !userId.trim())
                }
              >
                {busy ? "Saving…" : editing ? "Save access" : "Send invitation"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog
        open={Boolean(removing)}
        onOpenChange={(value) => {
          if (!busy && !value) setRemoving(undefined);
        }}
      >
        <DialogContent showCloseButton={!busy}>
          <DialogHeader>
            <DialogTitle>Remove {removing?.displayName}?</DialogTitle>
            <DialogDescription>
              They will lose access to every repository, PR, and review in{" "}
              {context.name}. Personal account resources are unaffected.
            </DialogDescription>
          </DialogHeader>
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => setRemoving(undefined)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() => void removeMember()}
            >
              {busy ? "Removing…" : "Remove member"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

/** Shows account invitations and creation for everyone, with management limited to the selected organization's managers. */
export function OrganizationsPage({
  currentUserId,
  initialContexts,
  initialOrganization,
  canManageMembers,
  canManageAccess,
}: Readonly<{
  currentUserId: string;
  initialContexts: ContextSnapshot;
  initialOrganization?: OrganizationSnapshot;
  canManageMembers: boolean;
  canManageAccess: boolean;
}>) {
  const router = useRouter();
  const snapshot = usePoll<ContextSnapshot>(
    "/api/contexts",
    initialContexts,
    5000,
  );
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const current = initialContexts.currentContext;
  const pending =
    snapshot.data?.invitations.filter(
      (invitation) => invitation.status === "pending",
    ) ?? [];
  const organizations =
    snapshot.data?.contexts.filter(
      (context) => context.kind === "organization",
    ) ?? [];

  /** Selects a newly created or existing organization through the server-authorized context cookie. */
  async function switchOrganization(contextId: string) {
    await mutate("/api/contexts/select", "POST", { contextId });
    router.replace("/organizations");
    router.refresh();
  }

  /** Creates an organization with the signed-in account as its first admin and switches to it. */
  async function createOrganization() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const result = await mutate("/api/contexts", "POST", {
        name: name.trim(),
      });
      const contextId = result.context?.id ?? result.id;
      if (!contextId)
        throw new Error("Organization created. Reload to select it.");
      await switchOrganization(contextId);
      setCreating(false);
      setName("");
      setMessage("Organization created.");
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "Unable to create organization. Try again.",
      );
    } finally {
      setBusy(false);
    }
  }

  /** Accepts or rejects only the signed-in account's invitation, then refreshes available contexts. */
  async function respond(
    invitation: OrganizationInvitationView,
    accept: boolean,
  ) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await mutate(
        accept
          ? `/api/invitations/${invitation.id}/accept`
          : `/api/invitations/${invitation.id}`,
        accept ? "POST" : "DELETE",
      );
      snapshot.setData((data) =>
        data
          ? {
              ...data,
              invitations: data.invitations.filter(
                (item) => item.id !== invitation.id,
              ),
            }
          : data,
      );
      setMessage(
        accept
          ? `Joined ${invitation.contextName}. Select it in the account switcher to view its repositories.`
          : `Invitation to ${invitation.contextName} declined.`,
      );
      router.refresh();
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "Unable to respond to invitation. Try again.",
      );
    } finally {
      setBusy(false);
    }
  }

  /** Switches to an organization while retaining safe feedback if access changed since the snapshot. */
  async function openOrganization(contextId: string) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await switchOrganization(contextId);
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "Unable to switch organization. Try again.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="console-hero-page flex min-w-0 flex-col">
      <ConsoleHero
        id="organizations-title"
        eyebrow="Shared review configuration"
        title="Organizations"
        description="Keep shared repositories and review configuration separate from your personal account."
      >
        <span className="console-hero-status">
          <Building2 aria-hidden="true" className="size-4" />
          {current.kind === "organization"
            ? "Organization account"
            : "Personal account"}
        </span>
      </ConsoleHero>
      <div className="console-container mt-6 mb-16 flex min-w-0 flex-col gap-5">
        <section className="console-card flex flex-col gap-4">
          <div className="flex flex-col gap-4 sm:flex-row sm:flex-wrap sm:items-start sm:justify-between">
            <div className="min-w-0 flex-1">
              <p className="text-xs font-medium text-muted-foreground">
                Selected account
              </p>
              <h2 className="mt-1 break-words text-2xl font-semibold tracking-tight">
                {current.name}
              </h2>
            </div>
            <Button
              className="self-start"
              onClick={() => {
                setError("");
                setCreating(true);
              }}
              disabled={busy}
            >
              <Plus data-icon="inline-start" />
              Create organization
            </Button>
          </div>
          <p className="text-sm leading-6 text-muted-foreground">
            Your account ID:{" "}
            <code className="break-all font-mono select-all">
              {currentUserId}
            </code>
            . Share it with an organization admin to receive an invitation.
          </p>
        </section>
        {(error || snapshot.error) && !creating && (
          <Alert variant="destructive">
            <AlertDescription>
              {error || "Unable to refresh organizations. Retrying…"}
            </AlertDescription>
          </Alert>
        )}
        {message && (
          <output aria-live="polite" className="text-sm text-muted-foreground">
            {message}
          </output>
        )}
        {pending.length > 0 && (
          <section
            className="flex min-w-0 flex-col gap-4"
            aria-labelledby="your-invitations"
          >
            <h2 id="your-invitations" className="text-lg font-semibold">
              Your invitations
            </h2>
            <div className="divide-y overflow-hidden rounded-xl border bg-card">
              {pending.map((invitation) => (
                <div
                  key={invitation.id}
                  className="flex min-w-0 flex-wrap items-center justify-between gap-4 p-4"
                >
                  <div className="flex min-w-0 flex-1 items-start gap-3">
                    <span
                      className="overview-metric-icon flex size-10 shrink-0 items-center justify-center rounded-lg"
                      data-tone="info"
                    >
                      <UserPlus aria-hidden="true" className="size-5" />
                    </span>
                    <div className="min-w-0">
                      <p className="break-words text-base font-semibold">
                        {invitation.contextName}
                      </p>
                      <p className="mt-1 break-words text-sm text-muted-foreground">
                        {
                          roles.find((role) => role.value === invitation.role)
                            ?.label
                        }{" "}
                        ·{" "}
                        {invitation.role === "member"
                          ? repositoryCount(invitation.repositoryIds.length)
                          : "All repositories"}
                      </p>
                    </div>
                  </div>
                  <div className="flex w-full flex-wrap gap-2 sm:w-auto">
                    <Button
                      variant="outline"
                      disabled={busy}
                      onClick={() => void respond(invitation, false)}
                    >
                      Decline
                    </Button>
                    <Button
                      disabled={busy}
                      onClick={() => void respond(invitation, true)}
                    >
                      Accept
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}
        {current.kind === "organization" && canManageAccess ? (
          <OrganizationManagement
            key={current.id}
            context={current}
            currentUserId={currentUserId}
            initialData={initialOrganization}
            canManageMembers={canManageMembers}
          />
        ) : (
          <section
            className="flex min-w-0 flex-col gap-4"
            aria-labelledby="your-organizations"
          >
            <h2 id="your-organizations" className="text-lg font-semibold">
              Your organizations
            </h2>
            {organizations.length ? (
              <div className="divide-y overflow-hidden rounded-xl border bg-card">
                {organizations.map((organization) => (
                  <div
                    key={organization.id}
                    className="flex min-w-0 flex-wrap items-center justify-between gap-4 p-4"
                  >
                    <div className="flex min-w-0 flex-1 items-start gap-3">
                      <span
                        className="overview-metric-icon flex size-10 shrink-0 items-center justify-center rounded-lg"
                        data-tone="info"
                      >
                        <Building2 aria-hidden="true" className="size-5" />
                      </span>
                      <div className="min-w-0">
                        <p className="break-words text-base font-semibold">
                          {organization.name}
                        </p>
                        <p className="mt-1 break-words text-sm text-muted-foreground">
                          {
                            roles.find(
                              (role) => role.value === organization.role,
                            )?.label
                          }{" "}
                          ·{" "}
                          {organization.role === "member"
                            ? repositoryCount(organization.repositoryIds.length)
                            : "All repositories"}
                        </p>
                      </div>
                    </div>
                    <Button
                      className="w-full sm:w-auto"
                      variant="outline"
                      disabled={busy || organization.id === current.id}
                      onClick={() => void openOrganization(organization.id)}
                    >
                      {organization.id === current.id
                        ? "Current organization"
                        : "Switch to organization"}
                    </Button>
                  </div>
                ))}
              </div>
            ) : (
              <Empty className="rounded-xl border bg-card">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <Building2 />
                  </EmptyMedia>
                  <EmptyTitle>No organizations yet</EmptyTitle>
                  <EmptyDescription>
                    Create an organization to share repositories, or accept an
                    invitation from an organization admin.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            )}
            {current.kind === "organization" && (
              <p className="text-sm text-muted-foreground">
                Organization admins and moderators manage repository access.
                Your access is limited to the repositories they select for you.
              </p>
            )}
          </section>
        )}
      </div>
      <Dialog
        open={creating}
        onOpenChange={(value) => {
          if (!busy) {
            setCreating(value);
            setError("");
          }
        }}
      >
        <DialogContent showCloseButton={!busy}>
          <DialogHeader>
            <DialogTitle>Create organization</DialogTitle>
            <DialogDescription>
              You will become its first admin. Resources belong to this
              organization when it is selected in the account switcher.
            </DialogDescription>
          </DialogHeader>
          <form
            className="flex flex-col gap-4"
            aria-busy={busy}
            onSubmit={(event) => {
              event.preventDefault();
              void createOrganization();
            }}
          >
            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            <FieldGroup>
              <Field data-disabled={busy}>
                <FieldLabel htmlFor="organization-name">
                  Organization name
                </FieldLabel>
                <Input
                  id="organization-name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  required
                  maxLength={120}
                  disabled={busy}
                />
              </Field>
            </FieldGroup>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => setCreating(false)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={busy || !name.trim()}>
                <Building2 data-icon="inline-start" />
                {busy ? "Creating…" : "Create organization"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </main>
  );
}
