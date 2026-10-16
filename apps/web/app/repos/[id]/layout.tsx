import Link from "next/link.js";
import { notFound } from "next/navigation.js";
import { GitBranch, ArrowUpRight } from "lucide-react";

import { getRepository } from "@razbor/database";
import { publicIdSchema } from "@razbor/contracts";

import { pageData } from "@web/lib/page-data.js";
import { canManageResource, requirePageUser } from "@web/lib/auth.js";
import { sanitizeRepositoryView } from "@web/lib/request-access.js";
import { RepositoryHeading } from "@web/components/repository-heading.js";
import { RepositoryNavigation } from "@web/components/repository-navigation.js";
import { Badge } from "@web/components/ui/badge.js";
import { Alert, AlertDescription } from "@web/components/ui/alert.js";

export const dynamic = "force-dynamic";

/**
 * Loads repository identity and section navigation, distinguishing missing repositories
 * from temporary storage failures.
 */
export default async function Layout({
  params,
  children,
}: Readonly<{
  params: Promise<{ id: string }>;
  children: React.ReactNode;
}>) {
  const { id } = await params;
  if (!publicIdSchema("repository").safeParse(id).success) notFound();
  const user = await requirePageUser({ repositoryId: id });
  const isAdmin = canManageResource(user, "repository");
  const repository = await pageData(async (db) => {
    const repository = await getRepository(db, id, user.context.id);
    return repository
      ? isAdmin
        ? repository
        : sanitizeRepositoryView(repository)
      : null;
  });
  if (repository === null) notFound();
  return (
    <main className="console-hero-page repository-detail-page flex min-w-0 flex-col">
      <RepositoryHeading
        id={id}
        title={
          repository?.metadata?.fullPath ??
          repository?.selector ??
          repository?.configKey ??
          "Repository"
        }
        description={
          isAdmin
            ? "Review activity, project indexing, and repository settings."
            : "Review activity for your repository."
        }
      />
      <div className="console-container mt-6 mb-16 flex min-w-0 flex-col gap-6">
        {repository ? (
          <div className="console-card flex min-w-0 flex-wrap items-center gap-3 text-xs text-muted-foreground">
            <span className="flex min-w-0 max-w-full items-center gap-1.5">
              <GitBranch className="size-3.5 shrink-0" aria-hidden="true" />
              <span className="min-w-0 break-all">
                {repository.metadata?.defaultBranch ?? "Configured branch"}
              </span>
            </span>
            {repository.metadata?.visibility && (
              <Badge variant="outline" className="font-normal capitalize">
                {repository.metadata.visibility}
              </Badge>
            )}
            <code className="break-all">{id}</code>
            {repository.metadata?.webUrl && (
              <Link
                href={repository.metadata.webUrl}
                target="_blank"
                rel="noreferrer"
                className="ml-auto inline-flex items-center gap-1 hover:text-foreground"
              >
                Open in forge
                <ArrowUpRight className="size-3.5" aria-hidden="true" />
              </Link>
            )}
          </div>
        ) : (
          <Alert variant="destructive">
            <AlertDescription>
              Repository details are unavailable.
            </AlertDescription>
          </Alert>
        )}
        <RepositoryNavigation id={id} isAdmin={isAdmin} />
        {children}
      </div>
    </main>
  );
}
