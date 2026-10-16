"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { usePoll } from "@web/lib/use-poll.js";

/**
 * Polls saved PR data and synchronizes providers once on entry or on demand.
 * Failed discovery keeps the last snapshot and exposes a visible freshness warning.
 */
export function usePullRequests<T>(url: string, initialData?: T) {
  const snapshot = usePoll<T>(url, initialData, 10000);
  const { setData } = snapshot;
  const [refreshing, setRefreshing] = useState(false);
  const [warning, setWarning] = useState("");
  const pending = useRef(false);
  const enteredUrl = useRef("");

  /** Refreshes authorized repositories, then adopts their saved data without hiding failures. */
  const refresh = useCallback(async () => {
    if (pending.current) return;
    pending.current = true;
    setRefreshing(true);
    setWarning("");
    try {
      const response = await fetch("/api/pull-requests/refresh", {
        method: "POST",
      });
      if (!response.ok) throw new Error("Refresh unavailable");
      const result = (await response.json()) as { failures: string[] };
      if (result.failures.length)
        setWarning(
          "Some repositories could not be refreshed. Their saved pull requests may be out of date. Try refreshing again.",
        );
      const saved = await fetch(url, { cache: "no-store" });
      if (!saved.ok) throw new Error("Snapshot unavailable");
      setData(await saved.json());
    } catch {
      setWarning(
        "Unable to refresh pull requests. The saved snapshot may be out of date. Try refreshing again.",
      );
    } finally {
      pending.current = false;
      setRefreshing(false);
    }
  }, [setData, url]);

  useEffect(() => {
    if (enteredUrl.current === url) return;
    enteredUrl.current = url;
    void refresh();
  }, [refresh, url]);

  return { ...snapshot, refreshing, warning, refresh };
}
