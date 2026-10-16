"use client";

import { useEffect, useState } from "react";

import type { ReviewJobView, ReviewLog } from "@razbor/contracts";
import type { publicationView } from "@razbor/database";

export type ReviewDetail = ReviewJobView & {
  interaction: Awaited<ReturnType<typeof publicationView>>;
};

export type LogLine = ReviewLog & { sequence: number };

/**
 * Tracks review state and deduplicated log events over SSE, reconnecting through
 * EventSource and closing on completion or cleanup.
 */
export function useReviewStream(id: string, initialData?: ReviewDetail) {
  const [job, setJob] = useState(initialData);
  const [lines, setLines] = useState<LogLine[]>([]);
  const [connection, setConnection] = useState<
    "connecting" | "live" | "reconnecting" | "finished"
  >("connecting");
  const [logsAvailable, setLogsAvailable] = useState(true);
  useEffect(() => {
    const source = new EventSource(`/api/reviews/${id}/events`);
    source.onopen = () => setConnection("live");
    source.onerror = () => setConnection("reconnecting");
    source.addEventListener("unavailable", () => setConnection("reconnecting"));
    source.addEventListener("review", (event) =>
      setJob(JSON.parse(event.data)),
    );
    source.addEventListener("log", (event) => {
      const line: LogLine = JSON.parse(event.data);
      setLines((current) =>
        current.some((existing) => existing.sequence === line.sequence)
          ? current
          : [...current, line],
      );
    });
    source.addEventListener("logs", (event) =>
      setLogsAvailable(JSON.parse(event.data).available),
    );
    source.addEventListener("done", () => {
      setConnection("finished");
      source.close();
    });
    return () => source.close();
  }, [id]);
  return { job, lines, connection, logsAvailable };
}
