import { Badge } from "@web/components/ui/badge.js";

/**
 * Maps review states and finding severities to semantic badge variants, using an
 * outline for unknown values.
 */
function statusVariant(value: string) {
  if (
    /failed|error|permission|unsupported|uncertain/.test(value) ||
    value === "high"
  )
    return "destructive";
  if (/^(completed|published)$/.test(value)) return "success";
  if (/^(queued|pending|medium)$/.test(value)) return "warning";
  if (/^(running|publishing|low)$/.test(value)) return "info";
  return "outline";
}

/**
 * Displays a human-readable status label with the variant selected for its raw state
 * value.
 */
export function Status({ value }: Readonly<{ value: string }>) {
  return (
    <Badge variant={statusVariant(value)}>{value.replaceAll("-", " ")}</Badge>
  );
}
