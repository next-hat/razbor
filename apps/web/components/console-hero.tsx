"use client";

import Link from "next/link.js";
import { usePathname } from "next/navigation.js";
import { Fragment, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";

/** Presents linked page ancestors and a heading over the shared planet image; authentication screens can omit the protected overview link. */
export function ConsoleHero({
  id,
  eyebrow,
  title,
  description,
  breadcrumbs = [],
  includeOverview = true,
  breadcrumbLabel = title,
  children,
}: Readonly<{
  id: string;
  eyebrow: string;
  title: string;
  description: string;
  breadcrumbs?: ReadonlyArray<{ label: string; href: string }>;
  includeOverview?: boolean;
  breadcrumbLabel?: string;
  children?: ReactNode;
}>) {
  const pathname = usePathname();
  const ancestors = [
    ...(includeOverview && pathname !== "/"
      ? [{ label: "Overview", href: "/" }]
      : []),
    ...breadcrumbs,
  ];
  return (
    <section aria-labelledby={id} className="console-hero">
      <div className="console-container flex flex-col py-5 sm:min-h-50">
        <nav aria-label="Breadcrumb" className="mb-4">
          <ol className="flex min-h-5 flex-wrap items-center gap-1.5 text-xs leading-5">
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
        <p className="mb-2 text-[10px] leading-3 font-medium tracking-[0.18em] text-muted-foreground uppercase">
          {eyebrow}
        </p>
        <h1
          id={id}
          className="text-2xl leading-tight font-semibold tracking-tight sm:text-[2rem]"
        >
          {title}
        </h1>
        <p className="mt-1.5 max-w-3xl text-sm leading-5 text-muted-foreground">
          {description}
        </p>
        {children && (
          <div className="mt-4 flex flex-wrap items-center gap-2">
            {children}
          </div>
        )}
      </div>
    </section>
  );
}
