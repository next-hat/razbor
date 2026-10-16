"use client";

import { usePathname } from "next/navigation.js";
import { GitBranch } from "lucide-react";

import { ConsoleHero } from "@web/components/console-hero.js";
import { repositorySettingsSections } from "@web/lib/repository-settings.js";

/** Presents a consistent section hero while linking its repository and settings ancestors. */
export function RepositoryHeading({
  id,
  title,
  description,
}: Readonly<{
  id: string;
  title: string;
  description?: string;
}>) {
  const pathname = usePathname();
  const repositoryPath = `/repos/${id}`;
  const settingsPath = `${repositoryPath}/settings`;
  const settingsSection = repositorySettingsSections.find(
    ({ path }) => path && pathname === `${settingsPath}/${path}`,
  );
  const breadcrumbs = [{ label: "Repositories", href: "/repos" }];
  let breadcrumbLabel = "Overview";
  let heroTitle = "Overview";
  let heroDescription =
    description ?? "Review activity and outcomes for this repository.";

  if (pathname === `${repositoryPath}/pull-requests`) {
    breadcrumbs.push({ label: title, href: repositoryPath });
    breadcrumbLabel = "Pull requests";
    heroTitle = "Pull requests";
    heroDescription =
      "Pull requests and automated review history for this repository.";
  } else if (pathname === `${repositoryPath}/memory`) {
    breadcrumbs.push({ label: "Repository", href: repositoryPath });
    breadcrumbLabel = "Memory";
    heroTitle = "Memory";
    heroDescription =
      "Read and maintain repository knowledge for future reviews.";
  } else if (pathname === settingsPath || settingsSection) {
    breadcrumbs.push({ label: "Repository", href: repositoryPath });
    breadcrumbLabel = "Settings";
    heroTitle = "Settings";
    heroDescription = "Manage repository connection and access settings.";
    if (settingsSection?.path) {
      breadcrumbs.push({ label: "Settings", href: settingsPath });
      breadcrumbLabel = settingsSection.label;
      const sections = {
        reviewer: {
          title: "Reviewer",
          description: "Choose the model configuration used for new reviews.",
        },
        guidance: {
          title: "Guidance",
          description:
            "Choose repository instructions and installed skills for reviews.",
        },
        mcp: {
          title: "MCP access",
          description: "Choose the MCP servers available to this repository.",
        },
        index: {
          title: "Index",
          description: "Manage the repository index and access tokens.",
        },
        webhook: {
          title: "Webhook",
          description:
            "Manage authenticated review events and webhook deliveries.",
        },
      };
      const section = sections[settingsSection.path];
      heroTitle = section.title;
      heroDescription = section.description;
    }
  }

  return (
    <ConsoleHero
      id="repository-section-title"
      eyebrow="Repository"
      title={heroTitle}
      description={heroDescription}
      breadcrumbs={breadcrumbs}
      breadcrumbLabel={breadcrumbLabel}
    >
      <span className="console-hero-status min-w-0 max-w-full">
        <GitBranch className="size-4 shrink-0" aria-hidden="true" />
        <span className="min-w-0 truncate" title={title}>
          {title}
        </span>
      </span>
    </ConsoleHero>
  );
}
