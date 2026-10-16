"use client";

import Link from "next/link.js";
import Image from "next/image.js";
import { usePathname, useRouter } from "next/navigation.js";
import { useEffect, useRef, useState } from "react";
import {
  LayoutGrid,
  GitBranch,
  GitPullRequest,
  Database,
  CircleUserRound,
  KeyRound,
  Server,
  Bot,
  BookOpen,
  Plug,
  Users,
  LogOut,
} from "lucide-react";

import type { ContextualUser } from "@web/lib/auth.js";
import type { ThemePreference } from "@web/lib/theme.js";
import { cn } from "@web/lib/utils.js";
import { ThemeSwitcher } from "@web/components/theme-switcher.js";
import { Button } from "@web/components/ui/button.js";
import { Alert, AlertDescription } from "@web/components/ui/alert.js";
import { ContextSwitcher } from "@web/components/context-switcher.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@web/components/ui/dropdown-menu.js";

const navigation = [
  { href: "/", label: "Overview", icon: LayoutGrid },
  { href: "/pull-requests", label: "Pull requests", icon: GitPullRequest },
  { href: "/repos", label: "Repositories", icon: GitBranch },
  { href: "/indexes", label: "Indexer", icon: Database, resource: "indexer" },
  { href: "/agents", label: "Agents", icon: Bot, resource: "agent" },
  { href: "/skills", label: "Skills", icon: BookOpen, resource: "skill" },
  { href: "/mcp", label: "MCP", icon: Plug, resource: "mcp" },
  { href: "/organizations", label: "Organizations", icon: Users },
  { href: "/runners", label: "Runners", icon: Server, instance: true },
  { href: "/users", label: "Users", icon: Users, instance: true },
];

/**
 * Pins account controls and permitted navigation above the page with a matching spacer.
 * Password-change sessions retain sign-out while workspace navigation stays hidden.
 */
export function ConsoleHeader({
  themePreference,
  user,
  managedResources = [],
}: Readonly<{
  themePreference: ThemePreference;
  user?: ContextualUser;
  managedResources?: readonly string[];
}>) {
  const pathname = usePathname();
  const router = useRouter();
  const headerRef = useRef<HTMLElement>(null);
  const shellRef = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const links = navigation.filter((link) =>
    link.instance
      ? user?.role === "super_admin"
      : link.resource
        ? managedResources.includes(link.resource)
        : true,
  );

  useEffect(() => {
    const header = headerRef.current;
    const shell = shellRef.current;
    if (!header || !shell) return;

    /** Keeps content below the fixed header when controls wrap or show an error. */
    function reserveHeaderSpace() {
      shell!.style.height = `${header!.getBoundingClientRect().height}px`;
    }

    reserveHeaderSpace();
    const observer = new ResizeObserver(reserveHeaderSpace);
    observer.observe(header);
    return () => observer.disconnect();
  }, []);

  /** Clears the current session and returns to sign-in after the server confirms logout. */
  async function signOut() {
    if (busy) return;
    setBusy(true);
    setError(false);
    try {
      const response = await fetch("/api/auth/logout", { method: "POST" });
      if (!response.ok) throw new Error("Logout failed");
      router.replace("/login?signed_out=1");
      router.refresh();
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div ref={shellRef} className="console-header-shell">
      <header ref={headerRef} className="console-header">
        <div className="border-b">
          <div className="console-container flex min-h-14 items-center justify-between gap-3 py-2">
            <div className="flex min-w-0 items-center gap-3 sm:gap-5">
              <Link
                href={
                  user
                    ? user.mustChangePassword
                      ? "/change-password"
                      : "/"
                    : "/login"
                }
                aria-label="razbor home"
                className="flex shrink-0 items-center gap-2 rounded-sm text-xl font-semibold tracking-tight focus-visible:outline-2 focus-visible:outline-ring"
              >
                <Image src="/logo.png" alt="" width={32} height={32} priority />
                <span className="hidden sm:inline">razbor</span>
              </Link>
              {user && !user.mustChangePassword && (
                <ContextSwitcher
                  key={user.context.id}
                  currentContext={user.context}
                  contexts={user.contexts}
                />
              )}
            </div>
            <div className="ml-auto flex shrink-0 items-center gap-1 sm:gap-2">
              <ThemeSwitcher preference={themePreference} />
              {user && (
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={
                      <Button
                        variant="ghost"
                        size="icon"
                        className="rounded-full"
                      />
                    }
                    aria-label={`Account menu for ${user.displayName}`}
                    disabled={busy}
                  >
                    <CircleUserRound className="size-5" aria-hidden="true" />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent
                    align="end"
                    sideOffset={12}
                    className="w-64 max-w-[calc(100vw-2rem)]"
                  >
                    <DropdownMenuGroup>
                      <DropdownMenuLabel className="px-3 py-3">
                        <span className="block truncate text-sm font-medium text-foreground">
                          {user.displayName}
                        </span>
                        {user.email && user.email !== user.displayName && (
                          <span className="mt-1 block truncate font-normal">
                            {user.email}
                          </span>
                        )}
                      </DropdownMenuLabel>
                      {user.authenticationMethod !== "oidc" && (
                        <>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            render={<Link href="/change-password" />}
                            className="min-h-(--console-control-height) px-2.5"
                          >
                            <KeyRound aria-hidden="true" />
                            Change password
                          </DropdownMenuItem>
                        </>
                      )}
                    </DropdownMenuGroup>
                    <DropdownMenuSeparator />
                    <DropdownMenuGroup>
                      <DropdownMenuItem
                        disabled={busy}
                        onClick={() => void signOut()}
                        className="min-h-(--console-control-height) px-2.5"
                      >
                        <LogOut aria-hidden="true" />
                        {busy ? "Signing out…" : "Sign out"}
                      </DropdownMenuItem>
                    </DropdownMenuGroup>
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
              <span role="status" className="sr-only">
                {busy ? "Signing out…" : ""}
              </span>
            </div>
          </div>
        </div>
        {error && (
          <div className="console-container py-3">
            <Alert variant="destructive">
              <AlertDescription>
                Unable to sign out. Try again.
              </AlertDescription>
            </Alert>
          </div>
        )}
        {user && !user.mustChangePassword && (
          <div className="border-b">
            <nav
              aria-label="Main navigation"
              className="console-container flex gap-5 overflow-x-auto"
            >
              {links.map(({ href, label, icon: Icon }) => {
                const active =
                  href === "/"
                    ? pathname === "/" || pathname.startsWith("/jobs/")
                    : pathname.startsWith(href);
                return (
                  <Link
                    key={href}
                    href={href}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "flex h-10 shrink-0 items-center gap-1.5 border-b-2 border-transparent text-[0.8125rem] text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring",
                      active &&
                        "border-primary text-primary hover:text-primary",
                    )}
                  >
                    <Icon className="size-3.5" aria-hidden="true" />
                    {label}
                  </Link>
                );
              })}
            </nav>
          </div>
        )}
      </header>
    </div>
  );
}
