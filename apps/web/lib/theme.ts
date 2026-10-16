export type ThemePreference = "light" | "dark" | "system";

export const themeCookieName = "razbor-theme";

/** Accepts supported preferences and falls back to the OS for missing or invalid cookies. */
export function parseThemePreference(value: unknown): ThemePreference {
  return value === "light" || value === "dark" ? value : "system";
}
