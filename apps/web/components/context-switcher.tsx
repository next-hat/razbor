"use client";

import { useState } from "react";
import { useRouter } from "next/navigation.js";

import type { ContextView } from "@razbor/database";

import { Alert, AlertDescription } from "@web/components/ui/alert.js";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@web/components/ui/select.js";

/** Switches the server-authorized account context and clears the previous page's client snapshots. */
export function ContextSwitcher({
  currentContext,
  contexts,
}: Readonly<{ currentContext: ContextView; contexts: ContextView[] }>) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const items = contexts.map((context) => ({
    value: context.id,
    label: context.name,
  }));
  const unavailable = !contexts.some(
    (context) => context.id === currentContext.id,
  );
  if (unavailable)
    items.unshift({ value: currentContext.id, label: "Unavailable context" });

  /** Changes the HTTP-only selection only after the server validates current account access. */
  async function selectContext(contextId: string | null) {
    if (!contextId || contextId === currentContext.id || busy) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/contexts/select", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contextId }),
      });
      if (!response.ok) throw new Error("Unable to switch account. Try again.");
      router.replace("/");
      router.refresh();
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "Unable to switch account. Try again.",
      );
      setBusy(false);
    }
  }

  return (
    <div className="flex min-w-0 flex-col gap-2 sm:w-64">
      <Select
        items={items}
        value={currentContext.id}
        onValueChange={(value) => void selectContext(value)}
        disabled={busy}
      >
        <SelectTrigger aria-label="Account context" className="w-full min-w-0">
          <SelectValue className="min-w-0 truncate" />
        </SelectTrigger>
        <SelectContent alignItemWithTrigger={false}>
          {(["personal", "organization"] as const).map((kind) => (
            <SelectGroup key={kind}>
              <SelectLabel>
                {kind === "personal" ? "Personal accounts" : "Organizations"}
              </SelectLabel>
              {contexts
                .filter((context) => context.kind === kind)
                .map((context) => (
                  <SelectItem key={context.id} value={context.id}>
                    {context.name}
                  </SelectItem>
                ))}
            </SelectGroup>
          ))}
        </SelectContent>
      </Select>
      {unavailable && (
        <Alert>
          <AlertDescription>
            This context is no longer available. Select another account.
          </AlertDescription>
        </Alert>
      )}
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}
