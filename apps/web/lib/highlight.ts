import { createHighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";

import { codeLanguage } from "@razbor/contracts/presentation";

const grammars = {
  /** Loads the typescript grammar only when a code block requests it. */
  typescript: () => import("shiki/langs/typescript.mjs"),
  /** Loads the tsx grammar only when a code block requests it. */
  tsx: () => import("shiki/langs/tsx.mjs"),
  /** Loads the javascript grammar only when a code block requests it. */
  javascript: () => import("shiki/langs/javascript.mjs"),
  /** Loads the jsx grammar only when a code block requests it. */
  jsx: () => import("shiki/langs/jsx.mjs"),
  /** Loads the rust grammar only when a code block requests it. */
  rust: () => import("shiki/langs/rust.mjs"),
  /** Loads the python grammar only when a code block requests it. */
  python: () => import("shiki/langs/python.mjs"),
  /** Loads the go grammar only when a code block requests it. */
  go: () => import("shiki/langs/go.mjs"),
  /** Loads the json grammar only when a code block requests it. */
  json: () => import("shiki/langs/json.mjs"),
  /** Loads the yaml grammar only when a code block requests it. */
  yaml: () => import("shiki/langs/yaml.mjs"),
  /** Loads the toml grammar only when a code block requests it. */
  toml: () => import("shiki/langs/toml.mjs"),
  /** Loads the bash grammar only when a code block requests it. */
  bash: () => import("shiki/langs/bash.mjs"),
  /** Loads the dockerfile grammar only when a code block requests it. */
  dockerfile: () => import("shiki/langs/dockerfile.mjs"),
  /** Loads the diff grammar only when a code block requests it. */
  diff: () => import("shiki/langs/diff.mjs"),
  /** Loads the html grammar only when a code block requests it. */
  html: () => import("shiki/langs/html.mjs"),
  /** Loads the css grammar only when a code block requests it. */
  css: () => import("shiki/langs/css.mjs"),
};

let highlighter: ReturnType<typeof createHighlighterCore> | undefined;

const languages = new Map<string, Promise<void>>();

/**
 * Lazily initializes shared highlighting themes and grammars, falling back to plain-
 * text tokens for unsupported languages.
 */
async function tokenize(code: string, language: string) {
  highlighter ??= createHighlighterCore({
    langs: [],
    themes: [
      import("shiki/themes/github-light.mjs"),
      import("shiki/themes/github-dark.mjs"),
    ],
    engine: createJavaScriptRegexEngine(),
  });
  const instance = await highlighter;
  const grammar = Object.hasOwn(grammars, language)
    ? grammars[language as keyof typeof grammars]
    : undefined;
  if (grammar && !languages.has(language))
    languages.set(language, instance.loadLanguage(grammar));
  await languages.get(language);
  return instance.codeToTokens(code, {
    lang: grammar ? language : "text",
    themes: { light: "github-light", dark: "github-dark" },
  }).tokens;
}

export type HighlightTokens = Awaited<ReturnType<typeof tokenize>>;

// Bound retained source/token data; polling and remounts reuse completed work.
const cache = new Map<string, Promise<HighlightTokens>>();

/**
 * Reuses up to 64 highlighting promises by normalized language and source, evicting
 * failed work so it can be retried.
 */
export function highlightCode(code: string, language: string) {
  const normalized = codeLanguage(language);
  const key = `${normalized}\0${code}`;
  let result = cache.get(key);
  if (!result) {
    result = tokenize(code, normalized);
    cache.set(key, result);
    if (cache.size > 64) cache.delete(cache.keys().next().value!);
    void result.catch(() => cache.delete(key));
  }
  return result;
}
