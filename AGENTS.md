# razbor development rules

## Imports

Group imports in this order, with one blank line between nonempty groups:

1. Native Node.js modules, using the `node:` prefix.
2. Third-party dependencies declared in `package.json`.
3. Other razbor workspaces, using their public `@razbor/<package>` exports.
4. Local modules within the current workspace, using its own `@<workspace>/*` alias.

Keep imports in the same group together. Apply the same grouping to type-only imports. Keep directives such as `"use client"` above imports, separated by a blank line.

Cross-workspace imports must use `@razbor/*`. Never import another workspace through its private alias, a relative filesystem path, or an unexported source path. Add an explicit package export when another workspace needs access to an existing module.

Local imports must use the owning workspace's alias instead of `./` or `../`:

| Workspace            | Internal alias | Public package      |
| -------------------- | -------------- | ------------------- |
| `apps/web`           | `@web/*`       | `@razbor/web`       |
| `apps/agent`         | `@agent/*`     | `@razbor/agent`     |
| `apps/runner`        | `@runner/*`    | `@razbor/runner`    |
| `packages/harness`   | `@harness/*`   | `@razbor/harness`   |
| `packages/contracts` | `@contracts/*` | `@razbor/contracts` |
| `packages/queue`     | `@queue/*`     | `@razbor/queue`     |

Public package names do not imply that every workspace exposes an importable API; respect each package's declared exports. In particular, use `@harness/*` only inside `packages/harness` and `@contracts/*` only inside `packages/contracts`. Root scripts are outside those workspaces and must use public `@razbor/*` exports too.

Example inside `apps/runner`:

```ts
import path from "node:path";

import Docker from "dockerode";

import type { QueueJob } from "@razbor/contracts";
import { logger } from "@razbor/harness/logger";

import type { ResolvedConfig } from "@runner/src/config.js";
```

## Declaration spacing

Separate top-level function, class, type, and variable declarations with a blank line. This includes individual schema and constant declarations in `@razbor/contracts`. Keep related declarations in their existing files; this spacing rule does not require one file per function or schema.

## Code documentation

- Give every named JavaScript/TypeScript function and method a JSDoc comment, including constructors, named arrow functions, nested helpers, and existing test helpers.
- Use Python docstrings for modules, classes, functions, and methods.
- Describe concrete behavior and explain non-obvious inputs, return values, side effects, failure conditions, or ownership rules. Avoid repeating the function name or TypeScript types.
- Keep inline comments for the reasoning behind constraints and ordering. Document anonymous callbacks when their behavior needs explanation; do not add boilerplate to straightforward callbacks.
- Update documentation alongside behavior changes so comments remain accurate.

## Tests

- Do not add tests or project-local mocks unless the user explicitly requests them. Organizing existing tests does not authorize new test cases or mocks.
- Keep all tests, integration checks, smoke checks and test-only fixtures/helpers under the root `tests/` directory, mirroring the owning project: `tests/apps/<app>/` or `tests/packages/<package>/`. For example, runner capability tests belong in `tests/apps/runner/capabilities.spec.ts`. Do not put tests or test-only helpers in production source directories.
- Name executable test files `*.spec.ts`; helper and fixture files must not use the `.spec.ts` suffix.
- Use Node's built-in test runner (`node:test`) with `node --import=tsx --test`, including for smoke checks. Keep runnable commands in the root `package.json`.
- Keep `pnpm test` limited to lightweight specs. Run checks requiring Codebase Memory, Docker or Kata through explicit integration/smoke commands.
- Document the test layout, commands, coverage, prerequisites, fixture behavior and cleanup in `tests/README.md`. Update it when existing checks or their execution requirements change. Report skipped or unrun checks accurately.
- Import application code through explicit public `@razbor/*` exports and local test helpers through `@tests/*`, following the import grouping rules above.

## Working discipline

- Inspect Git status and existing implementation first. Preserve unrelated edits.
- Do not switch branches, reset, stage files, or create commits unless explicitly requested.
- Prefer small, reviewable changes without unrelated architecture or features.
- Use Codebase Memory MCP first for code navigation when available. Check freshness and coverage, then read source where the index is stale or incomplete.
- Keep TypeScript execution through Node 24 and `node --import=tsx`; do not introduce a compilation requirement for runner, harness, or agent.
- Run relevant typecheck, lint, and formatting checks before reporting completion. Report validation and final worktree state; distinguish checks run from checks not run.
