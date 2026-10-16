"use client";

import Link from "next/link.js";
import { usePathname } from "next/navigation.js";

import { cn } from "@web/lib/utils.js";

/** Links settings sections to their own URLs and marks the displayed section. */
export function SettingsNavigation({
  items,
  label = "Settings sections",
}: Readonly<{
  items: ReadonlyArray<{ href: string; label: string }>;
  label?: string;
}>) {
  const pathname = usePathname();
  return (
    <nav
      aria-label={label}
      className="flex min-w-0 gap-2 overflow-x-auto rounded-xl border bg-card p-2"
    >
      {items.map(({ href, label }) => (
        <Link
          key={href}
          href={href}
          aria-current={pathname === href ? "page" : undefined}
          className={cn(
            "flex h-9 shrink-0 items-center rounded-lg px-3 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring",
            pathname === href && "bg-primary/10 text-primary",
          )}
        >
          {label}
        </Link>
      ))}
    </nav>
  );
}
