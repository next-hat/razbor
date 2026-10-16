import { cookies } from "next/headers.js";

import { ConsoleHeader } from "@web/components/console-header.js";
import { canManageResource, currentUser } from "@web/lib/auth.js";
import { parseThemePreference, themeCookieName } from "@web/lib/theme.js";
import "@web/app/globals.css";

export const metadata = {
  title: "razbor",
  description: "Comment-triggered code reviews",
  icons: { icon: { url: "/logo.png", type: "image/png" }, apple: "/logo.png" },
};

/**
 * Provides the document shell, global console navigation, and shared content width for
 * all pages.
 */
export default async function Layout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const user = await currentUser();
  const managedResources = user
    ? (
        [
          "repository",
          "agent",
          "skill",
          "mcp",
          "indexer",
          "organization",
        ] as const
      ).filter((resource) => canManageResource(user, resource))
    : [];
  const preference = parseThemePreference(
    (await cookies()).get(themeCookieName)?.value,
  );
  return (
    <html
      lang="en"
      data-theme={preference}
      className={preference === "dark" ? "dark" : undefined}
    >
      <body className="bg-background text-foreground antialiased">
        <ConsoleHeader
          themePreference={preference}
          user={user}
          managedResources={managedResources}
        />
        <div
          key={user?.context.id}
          className="console-page console-container py-6 pb-16"
        >
          {children}
        </div>
      </body>
    </html>
  );
}
