import { webhookView } from "@razbor/database";

import { requireSettingsRepository } from "@web/app/repos/[id]/settings/repository.js";
import { WebhookSettings } from "@web/components/webhook-settings.js";
import { pageData } from "@web/lib/page-data.js";

export const dynamic = "force-dynamic";

/** Loads repository forge details and webhook configuration and delivery status. */
export default async function Page({
  params,
}: Readonly<{ params: Promise<{ id: string }> }>) {
  const { id } = await params;
  const repository = await requireSettingsRepository(id);
  const hook = await pageData((db) => webhookView(db, id));
  return (
    <WebhookSettings
      key={id}
      id={id}
      initialRepository={repository}
      initialHook={hook}
    />
  );
}
