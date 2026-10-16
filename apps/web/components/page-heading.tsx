"use client";

import Link from "next/link.js";
import { usePathname } from "next/navigation.js";
import { Fragment } from "react";
import { ChevronRight } from "lucide-react";

/**
 * Links to the page's actual ancestors, leaving the current location unlinked, and
 * displays its title, optional status badges, and actions.
 */
export function PageHeading({
  title,
  description,
  breadcrumbs = [],
  breadcrumbLabel = title,
  badges,
  actions,
}: Readonly<{
  title: string;
  description?: React.ReactNode;
  breadcrumbs?: ReadonlyArray<{ label: string; href: string }>;
  breadcrumbLabel?: string;
  badges?: React.ReactNode;
  actions?: React.ReactNode;
}>) {
  const pathname = usePathname();
  const ancestors =
    pathname === "/" ? [] : [{ label: "Overview", href: "/" }, ...breadcrumbs];
  return (
    <div className="flex flex-col gap-4 border-b pb-6">
      <nav aria-label="Breadcrumb">
        <ol className="flex flex-wrap items-center gap-2 text-sm">
          {ancestors.map(({ label, href }) => (
            <Fragment key={href}>
              <li>
                <Link
                  href={href}
                  className="rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
                >
                  {label}
                </Link>
              </li>
              <li aria-hidden="true">
                <ChevronRight className="size-3.5 text-muted-foreground" />
              </li>
            </Fragment>
          ))}
          <li aria-current="page" className="min-w-0 break-words">
            {breadcrumbLabel}
          </li>
        </ol>
      </nav>
      <div className="flex flex-col gap-2">
        {badges && (
          <div className="flex flex-wrap items-center gap-2">{badges}</div>
        )}
        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
          <h1 className="min-w-0 break-words text-2xl font-semibold tracking-tight">
            {title}
          </h1>
          {actions}
        </div>
        {description && (
          <p className="text-sm leading-relaxed text-muted-foreground">
            {description}
          </p>
        )}
      </div>
    </div>
  );
}
