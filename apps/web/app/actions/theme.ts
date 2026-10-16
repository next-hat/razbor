"use server";

import { cookies } from "next/headers.js";

import { themeCookieName, type ThemePreference } from "@web/lib/theme.js";

/** Saves a validated theme for a year and lets Next.js rerender the document from the cookie. */
export async function saveThemePreference(preference: ThemePreference) {
  if (!["light", "dark", "system"].includes(preference)) {
    throw new Error("Unsupported theme preference");
  }
  (await cookies()).set(themeCookieName, preference, {
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
    sameSite: "lax",
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
  });
}
