import { RunnersPage } from "@web/components/runners-page.js";
import { runnerData } from "@web/lib/runners.js";

import { requirePageUser } from "@web/lib/auth.js";

export const dynamic = "force-dynamic";

/**
 * Seeds runner management with a current snapshot or lets the client recover when the
 * initial read fails.
 */
export default async function Page() {
  await requirePageUser({ admin: true });
  const initialData = await runnerData().catch(() => undefined);
  return <RunnersPage initialData={initialData} />;
}
