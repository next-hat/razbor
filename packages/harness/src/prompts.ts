import { fileURLToPath } from "node:url";

import { Liquid } from "liquidjs";

const prompts = new Liquid({
  root: fileURLToPath(new URL("./prompts/", import.meta.url)),
  strictVariables: true,
  strictFilters: true,
  ownPropertyOnly: true,
});

/** Renders an approved prompt template with strict variable and filter validation. */
export function renderPrompt(
  name:
    | "review"
    | "review-stage"
    | "review-final"
    | "review-focus"
    | "review-compact"
    | "review-group"
    | "review-cross-group"
    | "conversation"
    | "correction"
    | "diff"
    | "previous-findings"
    | "conversation-context"
    | "user-reply"
    | "repository-instructions"
    | "skills-guidance"
    | "included-skill"
    | "index-context"
    | "memory-guidance"
    | "tools/read-file"
    | "tools/read-diff"
    | "tools/exec"
    | "tools/web-search"
    | "tools/fetch-url"
    | "tools/find-skill"
    | "tools/read-skill",
  variables: Record<string, unknown> = {},
): Promise<string> {
  return prompts.renderFile(`${name}.md`, variables);
}
