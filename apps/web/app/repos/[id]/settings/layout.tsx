import { SettingsNavigation } from "@web/components/settings-navigation.js";
import { canManageResource, requirePageUser } from "@web/lib/auth.js";
import { repositorySettingsSections } from "@web/lib/repository-settings.js";

/** Guards repository settings and provides URL navigation between focused sections. */
export default async function Layout({
  params,
  children,
}: Readonly<{
  params: Promise<{ id: string }>;
  children: React.ReactNode;
}>) {
  const { id } = await params;
  const user = await requirePageUser({
    resource: "repository",
    repositoryId: id,
  });
  const base = `/repos/${id}/settings`;
  return (
    <div className="flex min-w-0 flex-col gap-6">
      <SettingsNavigation
        label="Repository settings sections"
        items={repositorySettingsSections
          .filter(
            ({ path }) =>
              path !== "index" || canManageResource(user, "indexer"),
          )
          .map(({ path, label }) => ({
            href: path ? `${base}/${path}` : base,
            label,
          }))}
      />
      {children}
    </div>
  );
}
