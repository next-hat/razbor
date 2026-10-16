import { RefreshCw } from "lucide-react";

import { Button } from "@web/components/ui/button.js";

/** Offers an explicit provider refresh and prevents duplicate requests while it runs. */
export function PullRequestRefresh({
  refreshing,
  refresh,
}: Readonly<{ refreshing: boolean; refresh: () => Promise<void> }>) {
  return (
    <Button
      variant="outline"
      disabled={refreshing}
      onClick={() => void refresh()}
    >
      <RefreshCw data-icon="inline-start" />
      {refreshing ? "Refreshing…" : "Refresh"}
    </Button>
  );
}
