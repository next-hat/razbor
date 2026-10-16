"use client";

import { useState, useTransition } from "react";
import { Monitor, Moon, Sun } from "lucide-react";

import { saveThemePreference } from "@web/app/actions/theme.js";
import { Button } from "@web/components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@web/components/ui/dropdown-menu.js";
import type { ThemePreference } from "@web/lib/theme.js";

const themes = [
  { label: "System", value: "system", icon: Monitor },
  { label: "Light", value: "light", icon: Sun },
  { label: "Dark", value: "dark", icon: Moon },
];

/** Offers an icon-triggered theme menu backed by the server's cookie preference. */
export function ThemeSwitcher({
  preference,
}: Readonly<{ preference: ThemePreference }>) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState("");
  const ThemeIcon = themes.find((theme) => theme.value === preference)!.icon;

  /** Saves supported selections, preventing concurrent writes and reporting failed requests. */
  function changeTheme(value: unknown) {
    if (value !== "light" && value !== "dark" && value !== "system") return;
    setError("");
    startTransition(async () => {
      try {
        await saveThemePreference(value);
      } catch {
        setError("Could not save theme. Try again.");
      }
    });
  }

  return (
    <div className="flex shrink-0 flex-col gap-1">
      <DropdownMenu>
        <DropdownMenuTrigger
          render={<Button variant="ghost" size="icon" />}
          aria-label="Theme"
          disabled={pending}
        >
          <ThemeIcon aria-hidden="true" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" sideOffset={12} className="w-40">
          <DropdownMenuGroup>
            <DropdownMenuLabel>Appearance</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={preference}
              onValueChange={changeTheme}
            >
              {themes.map(({ label, value, icon: Icon }) => (
                <DropdownMenuRadioItem
                  key={value}
                  value={value}
                  className="min-h-(--console-control-height)"
                >
                  <Icon aria-hidden="true" />
                  {label}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      {error && (
        <span role="alert" className="text-xs text-destructive">
          {error}
        </span>
      )}
    </div>
  );
}
