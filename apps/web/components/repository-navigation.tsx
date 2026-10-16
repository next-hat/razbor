"use client";

import Link from "next/link.js";
import { usePathname } from "next/navigation.js";
import {
  BookOpen,
  GitPullRequest,
  LayoutDashboard,
  Settings2,
} from "lucide-react";

import { cn } from "@web/lib/utils.js";

/**
 * Marks repository overview and pull requests for granted accounts, with memory and settings
 * navigation available only to administrators.
 */
export function RepositoryNavigation({
  id,
  isAdmin = false,
}: Readonly<{ id: string; isAdmin?: boolean }>) {
  const pathname = usePathname();
  return (
    <nav
      aria-label="Repository navigation"
      className="flex min-w-0 gap-6 overflow-x-auto border-b"
    >
      {[
        { href: `/repos/${id}`, label: "Overview", icon: LayoutDashboard },
        {
          href: `/repos/${id}/pull-requests`,
          label: "Pull requests",
          icon: GitPullRequest,
        },
        { href: `/repos/${id}/memory`, label: "Memory", icon: BookOpen },
        { href: `/repos/${id}/settings`, label: "Settings", icon: Settings2 },
      ]
        .filter(
          ({ label }) =>
            isAdmin || label === "Overview" || label === "Pull requests",
        )
        .map(({ href, label, icon: Icon }) => {
          const active =
            pathname === href ||
            (label !== "Overview" && pathname.startsWith(`${href}/`));
          return (
            <Link
              key={href}
              href={href}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex h-9 shrink-0 items-center gap-2 border-b-2 border-transparent text-sm font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring",
                active && "border-primary text-primary",
              )}
            >
              <Icon className="size-4" aria-hidden="true" />
              {label}
            </Link>
          );
        })}
    </nav>
  );
}
