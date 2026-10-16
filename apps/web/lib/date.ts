/**
 * Formats a valid timestamp to UTC seconds, returning an unavailable label for invalid
 * dates.
 */
export function formatUtc(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Unavailable"
    : `${date.toISOString().slice(0, 19).replace("T", " ")} UTC`;
}
