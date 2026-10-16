import { listMcpServers } from "@razbor/database/mcp";

import { McpPage } from "@web/components/mcp-page.js";
import { pageData } from "@web/lib/page-data.js";
import { requirePageUser } from "@web/lib/auth.js";

export const dynamic = "force-dynamic";

/** Server-renders registered HTTP MCP servers with client recovery for storage failures. */
export default async function Page() {
  const user = await requirePageUser({ resource: "mcp" });
  return (
    <McpPage
      initialData={await pageData((db) => listMcpServers(db, user.context.id))}
    />
  );
}
