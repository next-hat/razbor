import js from "@eslint/js";
import next from "@next/eslint-plugin-next";
import prettier from "eslint-config-prettier";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/node_modules/**", "**/.next/**", "**/next-env.d.ts"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["apps/web/**/*.{ts,tsx}"],
    plugins: { "@next/next": next },
    rules: {
      ...next.configs.recommended.rules,
      "@next/next/no-html-link-for-pages": "off",
    },
  },
  {
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    ignores: ["node_modules/**", ".next/**", "src/**"],
  },
  prettier,
);
