"use client";

import { useEffect, useState } from "react";

/**
 * Refreshes JSON at the requested interval (three seconds by default), fetches
 * immediately when no initial snapshot exists, retains successful data on errors,
 * and cancels requests on cleanup. A null URL pauses requests when the current account
 * cannot access that endpoint.
 */
export function usePoll<T>(
  url: string | null,
  initialData?: T,
  intervalMs = 3000,
) {
  const [data, setData] = useState<T | undefined>(initialData);
  const [error, setError] = useState(false);
  useEffect(() => {
    if (url === null) return;
    const requestUrl = url;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    /**
     * Fetches one uncached snapshot and schedules the next refresh unless the hook has
     * been aborted.
     */
    async function poll() {
      try {
        const response = await fetch(requestUrl, {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok)
          throw new Error(`Polling request failed (${response.status})`);
        setData(await response.json());
        setError(false);
      } catch {
        if (!controller.signal.aborted) setError(true);
      }
      if (!controller.signal.aborted) timer = setTimeout(poll, intervalMs);
    }
    if (initialData === undefined) void poll();
    else timer = setTimeout(poll, intervalMs);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [url, initialData, intervalMs]);
  return { data, error, setData };
}
