# Running tests

Use Node.js 24, pnpm 12.11.2, and Git. From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm run typecheck
pnpm run lint
pnpm run format:check
```

If pnpm is unavailable, use `npx --yes pnpm@12.11.2` in its place. `pnpm test`
runs the lightweight capability suite. Run the other suites for the area you
changed; integration and smoke checks are separate commands.

## Local checks

These suites need no Docker, database, model credentials, or live forge.

| Command                                     | Coverage                                                                      | Extra requirements                             |
| ------------------------------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------- |
| `pnpm test` or `pnpm run test:capabilities` | Skills, file/output limits, MCP validation, runner instructions               | Node 24 and Git                                |
| `pnpm run test:diff`                        | Diff pagination, pinned source reads, cancellation, usage reporting           | Temporary Git repositories and child processes |
| `pnpm run test:verification`                | Commands, timeouts, output limits, environment isolation, URLs, tool dispatch | Child processes and stdio pipes                |
| `pnpm run test:persistence:unit`            | Public IDs and GitHub, GitLab, and Forgejo HTTP adapters                      | Local sockets                                  |
| `pnpm run test:presentation`                | Review contracts, forge formatting, server-rendered components                | The script selects its TSX configuration       |
| `pnpm run test:coverage`                    | The default suite with a coverage report                                      | No additional requirements                     |

Run a spec or select tests by name:

```sh
node --import=tsx --test tests/apps/runner/capabilities.spec.ts
node --import=tsx --test --test-name-pattern='skills' tests/packages/harness/capabilities.spec.ts
```

Diff and verification tests use deterministic model responses. Verification tests
replace DNS and HTTP/HTTPS locally; provider tests use local HTTP fixtures.
Fixtures clean up their temporary repositories, processes, environment changes,
and mocks.

Presentation checks cover text, Markdown safety, source links, and rendered HTML.
Check layout, clipboard actions, disclosures, keyboard navigation, and both themes
in a browser.

## Autonomous review harness

Run the focused agent-loop, budget, context, relay and evaluation regressions:

```sh
pnpm run test:review
pnpm run test:diff
pnpm run test:verification
```

These deterministic provider fixtures exercise command-only exploration, immutable
finding locations, previous findings, automatic compaction, failure/cancellation,
whole-batch tool limits and conservative token/cost reservations. They measure
protocol behavior; scripted replies do not measure model finding recall or false
positives. Verification checks use installed Git/rg/grep/cat/sed/awk/head/tail/find
and deterministic process cleanup barriers; unavailable optional utilities are
reported as skipped. No real model, database or infrastructure credentials are
needed. All temporary repositories and evaluation files are removed by fixtures.

## Audited revision evaluation

`tests/evaluation/audited-revisions.json` contains exact revision comparisons,
audited defects, and negative controls. It is a curated dataset, not an executable
spec.

```sh
pnpm evaluate validate tests/evaluation/audited-revisions.json
pnpm evaluate plan tests/evaluation/audited-revisions.json
```

The evaluation CLI regression specs also check historical-record compatibility,
failed-attempt telemetry, cache splits and configuration grouping. Scoring exposes
turns, tool calls, cached/uncached/cache-write tokens and conservative budget
charges, preserving unknown fields. These specs never dispatch a model.

The offline `record` and `score` commands process independently assessed execution
records. They do not call a model or publish reviews. See the
[evaluation guide](../docs/review-evaluation.md) for formats, scoring, and isolated
execution requirements. Keep outputs outside the checkout. Report live replay
separately; it needs authorized model access and the runner's resource limits.

## Database and provider integration

These suites create disposable Docker resources. The host must reach containers
on Docker bridge addresses, as with a local Linux Docker installation.

```sh
docker pull postgres:17-alpine
pnpm run test:persistence
pnpm run test:comments
```

| Command                     | Coverage                                                                                                                 |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `pnpm run test:persistence` | Migrations, IDs, access boundaries, registry, tokens, database/queue recovery, stale attempts, saved completion          |
| `pnpm run test:comments`    | Commands, webhook HMAC, deduplication, hook setup, acknowledgement fallback, Forgejo publication against a local fixture |

The fixture creates PostgreSQL migration and restricted runtime roles, including
the pg-boss schema. Comment tests use local sockets and never contact a real forge
or model. The database-outage case intentionally logs a sanitized unavailable
message.

These suites do not cover live permissions, native multi-line comments, thread
replies, or the full repeat-review flow. See [reviews and webhooks](../docs/comment-reviews.md).

### Live GitHub setup checks

Use disposable provider data and a running Razbor instance. You need an admin
session, permission to create and install a private GitHub App, a test repository,
and a public HTTPS webhook callback. The console return URL may be local if your
signed-in browser can reach it. Full reviews also need an agent, ready index, and
assigned runner.

- Create and install an App through the console. Check cancellation, expired or
  repeated callbacks, and unauthorized access.
- Reuse it for another selected repository. Confirm unselected repositories and
  changed installation IDs cannot grant access.
- Check indexing, checkout, bot publication, and access after the original
  one-hour installation token expires. Suspend or uninstall the App, or remove
  repository access, and confirm later operations fail.
- Connect manually with a token lacking Webhooks write permission. Configure the
  displayed URL, one-time secret, and four events. Check signed ping readiness;
  wrong secrets and other repositories must not mark it ready.
- Delete registrations. Manual hooks remain for the operator to remove;
  automatically managed hooks remove their own hook. Other App repositories
  must remain usable.

Repeat for each GitHub Enterprise deployment you support. Remove disposable hooks,
registrations, and installations afterward. Record these results separately from
the local suites.

## Indexer integration

This suite uses Codebase Memory, Git, PostgreSQL, local sockets, and temporary
repositories. It covers fetching, refresh, revision boundaries, token expiry and
revocation, dirty checkouts, divergence recovery, and cleanup.

Provision the pinned v0.11.0 bundle using the [indexing guide](../docs/indexing.md):

```sh
export RAZBOR_CBM_BUNDLE=/absolute/path/to/codebase-memory-bundle
CBM_EXECUTABLE="$RAZBOR_CBM_BUNDLE/codebase-memory-mcp" pnpm run test:indexer
```

Docker and `postgres:17-alpine` are also required. The spec skips without
`CBM_EXECUTABLE`; report that as skipped. It uses its own database and source
directory, reads no live credentials, and does not enable embeddings.

## Kata runner smoke check

This runs a review through Next.js, the production runner, queue, and Codebase
Memory. A local deterministic model requests a skill, graph query, and source read
before returning a finding. It uses no paid model or real forge publication.

Requirements:

- Linux Docker with a working `kata` runtime.
- The provisioned Codebase Memory v0.11.0 bundle.
- Local `postgres:17-alpine` and `node:24-bookworm` images.
- A runner image built with `docker compose build runner`.
- Network access for dependency installation and the inner image pull.
- `/run/systemd/resolve/resolv.conf`, or another upstream resolver file set through
  `RAZBOR_RUNNER_RESOLV_CONF`.

```sh
docker pull node:24-bookworm
docker compose build runner
RAZBOR_CBM_BUNDLE=/absolute/path/to/codebase-memory-bundle pnpm run smoke:capabilities
```

The default image is `razbor-runner:0.1.0`; set `RAZBOR_RUNNER_IMAGE` to use another
compatible local image. Missing Kata, bundle, or image prerequisites fail the run.
The runner and nested Docker daemon share a Kata VM; the agent uses `runc`.

The fixture enrolls through the management CLI and TOML, signs in with generated
credentials, and uses that session for submission and reads. Source travels
through the review's Git-pack endpoint. The runner receives no database or
index-management credentials.

The total deadline is 15 minutes, with up to five minutes each for dependency
installation and startup, and three for the review. All phases share the total
budget. Docker API calls allow 60 seconds of socket inactivity; installer start
and inspection share a five-minute abort deadline.

The dependency installer uses the host UID and disposable pnpm/XDG directories in
`/tmp`. Dependencies use the frozen lockfile and hoisted layout. Next.js starts
directly with Webpack and the configured TypeScript extension aliases. The fixture
mounts a disposable writable `next-env.d.ts`; the checkout stays read-only. The
inner image cache is temporary.

## Fixtures and cleanup

Tests create commits only inside temporary fixture repositories. Docker fixtures
track and remove their own containers, anonymous volumes, networks, and dependency
volumes. The Kata fixture also removes its enrollment files and job directory.
Cleanup stops owned containers first and retries conflicts for up to 30 seconds
per resource. Cleanup failures retain the original failure and fail an otherwise
successful run.

Fixtures do not reset development databases, prune Docker, delete user volumes,
install Kata, or use live credentials. After an interruption, identify the run's
resources before removing them. Missing dependencies or blocked sockets mean a
check is blocked or unrun.

## Coverage and CI

`pnpm run test:coverage` writes `coverage/lcov.info` and a terminal summary for
the default suite. Integration and smoke results are excluded. Unexecuted source
in `apps/`, `packages/`, and `scripts/` counts as uncovered; declarations, build
output, dependencies, and tests are excluded. c8 clears earlier reports on each
run. The `coverage/` directory is ignored by Git.

No CI workflow is included in this checkout. Run the checks above locally or
configure your CI to invoke them.

## Feature checks that need a running app

Use disposable data and report these checks separately from automated results:

| Feature                                             | Check                                                                                                                                                    |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Accounts and OIDC                                   | Login, password changes, session expiry/revocation, repository grants, provider profiles, group-to-role mapping                                          |
| [Repository connection](../docs/comment-reviews.md) | Forge errors, agent creation, one-time secrets, setup recovery, runner enrollment and assignment                                                         |
| [Runners](../docs/runner.md)                        | Single-use/expired tokens, drain/revoke, credential replacement, capacity, remote recovery                                                               |
| [Memory](../docs/memory.md)                         | Editing, search, restore, drafts, conflicts between people and bots                                                                                      |
| [Skills](../docs/skills.md)                         | Import/editor, selection, nested instructions, pinned queued contents, tool use                                                                          |
| [MCP](../docs/mcp.md)                               | Real server credentials, initialization, calls, revocation during a review                                                                               |
| [Search](../docs/indexing.md)                       | Real embedding models and pgvector, revision/repository boundaries, refresh, deleted Markdown                                                            |
| [Metrics](../docs/review-metrics.md)                | Known counts, filters, retry usage, evaluation saves, browser interactions                                                                               |
| Pull requests                                       | Discover unreviewed PRs, retain IDs, confirm closure, preserve snapshots on refresh failure, repository grants, search, history, stale revisions, themes |
| [Comment reviews](../docs/comment-reviews.md)       | Webhooks, publication, repeat assessments, recap edits, replies, resolution                                                                              |

Model-loop fixtures include serial command batches and budget rejection before
any batch side effect. Live concurrent cancellation and retrieval relevance still
need isolated runtime acceptance. Integration success does not measure model
autonomous tool selection or
[review quality](../docs/review-evaluation.md).

`pnpm run submit <repository-key> <checkout> <base> <head>` submits committed
revisions and can start a real review. It is an operator command, not a test.
See [local commands](../docs/getting-started.md#local-commands) for its database
requirements.

## Test layout

Keep specs and helpers under `tests/apps/<app>/` or `tests/packages/<package>/`.
Executable specs use `*.spec.ts` and `node:test` with `node --import=tsx --test`;
helpers do not use the spec suffix. Import production code through public
`@razbor/*` exports and local helpers through `@tests/*`.

Keep commands in the root `package.json`, with Docker, Kata, and Codebase Memory
checks separate from `pnpm test`. Follow [AGENTS.md](../AGENTS.md) before adding
tests or mocks, and update this guide when prerequisites or cleanup change.
