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
runs the lightweight capability and registry compatibility checks. Run the other suites for the area you
changed; integration and smoke checks are separate commands.

## Local checks

These suites need no Docker, database, model credentials, or live forge.

| Command                          | Coverage                                                                                       | Extra requirements                             |
| -------------------------------- | ---------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `pnpm test`                      | Skills, file/output limits, MCP validation, runner instructions and legacy registry defaults   | Node 24 and Git                                |
| `pnpm run test:review`           | Autonomous loop, compaction, budgets, relay retry policy, cumulative progress, offline scoring | Temporary Git repositories and child processes |
| `pnpm run test:diff`             | Diff pagination, pinned source reads, cancellation, usage reporting                            | Temporary Git repositories and child processes |
| `pnpm run test:verification`     | Commands, timeouts, output limits, environment isolation, URLs, tool dispatch                  | Child processes and stdio pipes                |
| `pnpm run test:persistence:unit` | Public IDs, trigger policy parsing, provider lifecycle events and bot-owned comment operations | Local sockets                                  |
| `pnpm run test:presentation`     | Review contracts, forge formatting, server-rendered components                                 | The script selects its TSX configuration       |
| `pnpm run test:release`          | Explicit image publication tags and local-load defaults                                        | Bash; temporary fake Docker/Git, no daemon     |
| `pnpm run test:coverage`         | The default suite with a coverage report                                                       | No additional requirements                     |

Run a spec or select tests by name:

```sh
node --import=tsx --test tests/apps/runner/capabilities.spec.ts
node --import=tsx --test --test-name-pattern='skills' tests/packages/harness/capabilities.spec.ts
```

Diff and verification tests use deterministic model responses. Verification tests
replace DNS and HTTP/HTTPS locally; provider tests use local HTTP fixtures.
Fixtures clean up their temporary repositories, processes, environment changes,
and mocks.

Presentation checks cover text, Markdown safety, source links, rendered HTML, and disabled repository indexes with stale preparation errors.
Check layout, clipboard actions, disclosures, keyboard navigation, and both themes
in a browser.

Review trigger and comment checks use local HTTP provider fixtures and isolated PostgreSQL
databases. They exercise source-only and indexed policy decisions with simulated
attempts and controlled results. The GitLab fork fixture opens an MR before its
diff refs exist. It checks that the dispatcher recovers the first review after
a restart, retries source and readiness changes, and ends old opt-ins while a diff
is pending. A temporary GitLab outage preserves the deferred delivery. A response
pointing to a different project retires it and stops further provider reads.
Webhook settings edits revoke deferred work and retain the timestamp
that prevents a pre-reopen command from activating a new continuous session.
The fixture also holds a closed-command lookup open while an untracked MR
reopens, then checks that a post-reopen command enables review of the next push.
The delayed-delivery check inspects the queued head before sending another update.
The public PR check uses different authors in the signed event and the forge response.
Publication checks cover webhook disablement and opt-in revocation before submission,
recovery after a lost response, unconfirmed GitLab verdicts, and reuse of a saved
result after draft cleanup. The GitLab fixture also checks that unconfirmed
follow-ups show unanchored findings, that later reviews suppress verified inline
duplicates, and that the management CLI can abandon an ambiguous bulk without
resubmitting it or deleting another user's draft.
For checkpoints that record the bot ID, recovery requires matching credentials
and succeeds without an operator-supplied ID.
It also drops a ready event after the MR's diff refs change, refreshes with the
webhook disabled, and verifies that refresh after re-enablement recovers and
publishes the matching result exactly once.
The Forgejo fixture refreshes an unreviewed PR before its signed title edit and
checks that the edit starts exactly one review. It also overlaps detail reads
with a webhook and checks which readiness information survives a missing detail
field or a changed revision. A failed detail request defers updates to another
tracked PR and a newly listed PR until the fixture's next successful refresh.
When an untracked PR listing omits the draft flag, the fixture checks that an
unchanged title preserves readiness and a rename clears it and advances the generation.
The status-comment fixture covers masked 404s, deletion during an active review,
and recovery after a bot rotation through restored credentials or manual removal.
The Forgejo provider fixture accepts web and API pull-request URLs from their
configured origins and rejects mismatched repositories, PRs, and origins.
The GitLab provider fixture checks status-comment cleanup on a 1,000-note MR.
These checks do not need model credentials.

## Merge policy and triage

The reviewer-routing fixtures use a real Git rename in indexed and source-only reviews. They check that the harness records owners of the old and new paths even when the model omits them or supplies a fabricated owner. The PostgreSQL triage test carries the saved owner through ranking, provider identity checks and recovery of a single reviewer notification.

`pnpm test` includes the pure policy engine, assessment validation, thresholds, reviewer selection and safe comment rendering. `pnpm run test:review` exercises both review modes with deterministic model responses. `pnpm run test:presentation` checks console priority, filtering, aging decisions and file-managed settings. It also verifies that only managers receive configured reviewer candidates in the current PR decision, latest review and review history. The scoped PostgreSQL PR projection is covered by `pnpm run test:persistence`, including initial comparison refs, revision changes and outstanding native merges. The real-Git fixtures run the policy decision with automatic approval enabled and provider checks passing. A manifest alone, head-only source reads, or full patches for only some changed files require human review. Complete `read_diff` pages or matching pinned Git output for every changed file preserve eligibility. The harness fixtures also cover diff continuations and source ranges clipped by a tool page. Completing the missing pages or supplying the matching pinned contents restores the evidence. Unrelated commands, failed verification, truncated output, and binary files cannot satisfy a pending read. The contract suite checks the conversation size limit, malformed assessment decisions and exclusion of private policy evidence from member views and forge comments. The dispatcher fixture verifies that unavailable accounts do not consume the three available reviewer mentions.

The triage suite checks that a dry run leaves one confidence comment and clears its retry deadline after delivery. Live-mode fixtures check the stored deadlines for provider permission failures and rate limits and verify that another dispatcher does not poll early. Opt-in approval fixtures cover competing workers, a lost acknowledgement, a withdrawn vote during live merge recovery, and approval without a merge request. A same-head escalation withdraws an earlier vote, including after a lost response. A pending withdrawal blocks a replacement vote on a later head, and policy changes keep the old version until withdrawal is confirmed. The provider suite exercises revision-bound GitHub and GitLab votes, read-only recovery while a native schedule is armed, and Forgejo’s explicit refusal. It covers optional GitHub checks, transient readiness, stale-review settings, GitLab reviewer pagination and missing merge-train configuration.

`pnpm run test:merge-providers` exercises provider request and response fixtures, including guarded refusals, an acknowledged GitLab schedule with an unnamed owner, refusal of every fresh or resumed native GitHub schedule, and recovery of legacy GitHub checks. GitHub fixtures cover changed schedule owners, terminal outcomes, later pages, rate-limited cancellation and revision-bound dismissal. Approval fixtures also exercise older pages of App-authored reviews and check that incomplete history cannot trigger a duplicate vote. GitLab approval fixtures cover acknowledged, ambiguous and changed-head withdrawals. The triage fixtures also cover retirement of a pending check left by a definitive native refusal. These checks do not exercise live installations. `pnpm run test:triage` requires Docker, the local `postgres:17-alpine` image and Node 24. It upgrades populated Phase 2 databases through `0032_gitlab_session_boundaries` and both published Phase 3 preview histories. It verifies retained policy versions and historical findings, GitLab session-boundary backfill, independent approval state, previously idle preview votes becoming due for reconciliation, and repeatable migration runs. Unknown hashes at the colliding timestamps stop the upgrade. The suite verifies default isolation and frozen Markdown, and exercises actual PostgreSQL locks, confirmed/uncertain writes, durable native dispatch stages, interrupted cancellation, restart recovery and revision races. Its two-client barriers exercise fair dispatch under a busy repository lock. Delayed reservations and deleted comments verify that recovery delivers one escalation and preserves mention history. The PostgreSQL fixture delivers timed-out edits out of order after closure. It checks that each exact readback clears its own receipt, preserves the single reviewer notification, corrects the visible decision and lets the settled PR sleep after the final receipt. Registry imports exercise credential rotation and source-only changes with both confirmed and uncertain native merge requests. The tests check that a successful source edit invalidates earlier reviews even when the policy and PR commit remain the same. The dispatcher test substitutes a guarded forge capability to test generic scheduling independently of each provider's support. All provider I/O in these tests is controlled locally. The fixture removes its databases, container, volumes and network when the test finishes.

The triage fixture switches an eligible preview to a development HTTP URL on Forgejo and GitLab. It checks that no request leaves the process, the saved preview becomes blocked, and HTTPS restores eligibility. Provider and dispatcher fixtures distinguish an expired request budget before a vote or withdrawal from a lost response after submission. They cover GitHub GraphQL rate limits returned with HTTP 200, GitLab HTTP 429 retry deadlines, and the squash commit reported on a merged MR. Runner fixtures cover a completed two-turn review, a declined tool batch, and recovery after an invalid diff cursor. Forgejo webhook fixtures cover a Refresh followed by a same-head ready event.

The console re-review fixture resolves two occurrences from the same PR across separate admission snapshots. It checks that an occurrence outside the current snapshot still blocks the merge decision and that a prior resolution is rechecked after the PR revision changes. The publication fixture resolves a thread while posting a new occurrence from the same review.

The runner finalization fixture temporarily removes a Git object before a file read, restores it, and retries. It checks that complete pages for the requested path and revision clear the failure, and that a different path, revision or range leaves it outstanding.

The GitLab schedule fixtures change the pipeline and merge restrictions on an existing bot-owned schedule. The adapter, dispatcher and console tests check the current decision, continued tracking of the schedule and the absence of a second submission.

GitHub approval fixtures exercise optional check runs and commit statuses with `requirePassingChecks` enabled and disabled. They also check a required context reported by both APIs and a required check bound to a specific GitHub App.

## Autonomous review harness

Run the focused agent-loop, budget, context, relay and evaluation regressions:

```sh
pnpm run test:review
pnpm run test:diff
pnpm run test:verification
```

These deterministic provider fixtures exercise command-only exploration, immutable
finding locations, exact manifest and previous-finding retention, compaction-window
chunking without truncated tool-reference aliases, a 64k window with the default 80k trigger, immutable-context floors,
large continuation notes followed by consecutive tools without redundant summaries,
failure/cancellation, budget notices, final-response headroom, correction instructions
retained after an invalid final output triggers compaction, and budget-limited
conversation disclosures. Concrete missing required-tool warnings and summary
limitations are enforced independently of model text without repeating generic
preflight notices. They cover refused tool batches without command execution, strict token/cost reservations,
independent missing input/output reservations, provider/model price selection
and legacy configuration compatibility. Relay cases
exercise opt-in known nonbillable throttles, capped fallback backoff, explicit
Retry-After, shared credential pacing after oversized HTTP429 bodies, one request
deadline and permanent/ambiguous error rejection. Cumulative progress cases preserve coherent
usage/cost snapshots after 500 events and keep cache data unknown after usage gaps.
`tests/apps/runner/finalization.spec.ts` sends native OpenAI Responses and Anthropic
Messages payloads through the real model adapter and runner relay, intercepting
only external provider I/O. It checks stable tool definitions with historical
calls/results, explicit `none` during finalization and truncated-output correction,
no execution of unexpected finalization calls, and tool-free independent compaction.
These fixtures measure protocol behavior; scripted replies do not measure model finding recall or false
positives. Verification checks use installed Git/rg/grep/cat/sed/awk/head/tail/find
and deterministic process cleanup barriers; unavailable optional utilities are
reported as skipped. No real model, database or infrastructure credentials are
needed. All temporary repositories and evaluation files are removed by fixtures.

The release-script regressions run the real shell script with temporary Docker
and Git recorders. They verify rejection of implicit publication tags before any
Docker invocation, explicit CLI/environment tag selection, local load defaults,
and Dockerfile stage selection for source-only and standard builds.
Run `pnpm run test:release` separately from provider and database integration suites.

## Audited revision evaluation

`tests/evaluation/audited-revisions.json` contains exact revision comparisons,
audited defects, and negative controls. It is a curated dataset, not an executable
spec.

```sh
pnpm evaluate validate tests/evaluation/audited-revisions.json
pnpm evaluate plan tests/evaluation/audited-revisions.json
```

The evaluation CLI regression specs also check historical-record compatibility,
failed-attempt telemetry, cache splits, configuration grouping and runner-compatible
single/multiple provider-model pricing, including duplicate identities and
monetary caps without matching model prices. Both record and score reject those
invalid caps while historical omitted settings remain unknown. Scoring exposes
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
pnpm run test:broker
```

| Command                     | Coverage                                                                                                                                                                                                       |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm run test:persistence` | Migrations, IDs, access boundaries, registry, tokens, database/queue recovery, stale attempts, saved completion                                                                                                |
| `pnpm run test:comments`    | Signed events, PR opt-in and reset, revision coalescing, same-revision re-review, status-comment recovery, Forgejo publication, exact finding identities, open and resolved threads, and duplicate suppression |

The broker suite uses pg-boss and enrolled runner sessions, with a controlled
loopback source service. It checks indexed and source-only assignments across a
repository setting change, source forwarding, attempt tokens, the private index
MCP endpoint and independent durable memory, without a model endpoint. A source
transfer with a live grant remains valid past the former 30-second cutoff. Database
regressions cover file ownership, legacy defaults, attempt snapshots and index
token authorization. A setup regression disables and re-enables indexing before
an active preparation publishes its result, and accepts only the revision the
persistent workspace actually prepared. Broker tests exercise capability-based
creation defaults and the review error for an unavailable required index. A
database constraint forces the terminal write to fail, so the broker test
can verify that pg-boss retries the job and the review subsequently finishes.
The broker also retries an indexed review after a transient source-service
failure and delivers it under a new attempt ID. Persistence checks compare
the full repository list before and after an outage and recovery, including
unrelated setup errors and active preparations.

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
signed-in browser can reach it. Full reviews also need an agent, any enabled index, and
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

These specs use disposable PostgreSQL databases. Review handoff cases run the
service against local bare Git repositories. The source-only case needs Git, Docker, local sockets and
`postgres:17-alpine`. It imports the pinned base and feature-branch commits through the runner
checkout path and checks attempt authorization, lease expiry and removal. It also
checks that stale Git policies and invalid or symlinked index directories cannot
block source preparation or cause cleanup to delete unrelated files. The fixture
runs without a graph binary, vector extension or embedding endpoint. It checks
the configured timeout for pack generation and transfer, and the runner timeout
for downloading and importing that pack. A controlled
barrier verifies that a queued source transfer must pass authorization at
dispatch. Each barrier fails if its request ends early. Condition polling
shares a deadline with the underlying HTTP fetch. A stalled predicate exercises
that deadline. Capability checks cover missing and invalid bundles. Startup recovery
tests exercise an invalid temporary mapping and empty or occupied daemon runtime
directories. Across repeated cleanup scans, each invalid mapping logs one
warning. The tests check that the service revokes a quarantined temporary
checkout, resumes a pending persistent deletion after its path is repaired,
and preserves an active persistent checkout and unrelated files.
The fixtures remove their workspaces, sockets and databases.

The indexed case simulates a transient read error on the pinned executable.
It verifies that health reports unknown graph capability, reviews can retry,
and an interrupted on-demand index waits for another request. It also checks
read and execute permission denials. After read permission returns on the same
executable, the test checks that requests during the digest retry cooldown
receive a retryable response. Removing and restoring the fixture's bundle
verifies the outage diagnostic and automatic recovery of queued setup. A
separate case restores the bundle after the indexer confirms it is inaccessible
and checks that persistent indexing resumes automatically. A checkout restored
immediately after a failed spawn must still produce a setup error.
Another case keeps the bundle offline through daemon cleanup. After restoration,
the reaper confirms shutdown, starts a fresh graph and indexes the expected commit.
The indexed integration test allows five minutes for these launches and the
watcher refreshes.
It also exercises fetching, refresh, pinned graph access,
revocation, dirty checkouts, divergence recovery and cleanup. The concurrent
refresh check waits for the stored workspace state before querying the graph.
A connected client checks the current Git policy after a branch change.
A PostgreSQL advisory lock
and trigger interrupt retirement at its durable state write so re-enabling can
exercise the cleanup retry. A separate test holds a stale database snapshot
while a repository is re-enabled, waits for retirement to settle before
checking the retained handle, refreshes its workspace by ID, and
checks that the graph daemon stops and the checkout survives when the registry
is unavailable during shutdown. Another holds startup inside a database
transaction to verify that the successor can acquire the storage lock only
after the original service finishes with it.

Provision the pinned v0.11.0 bundle using the [indexing guide](../docs/indexing.md):

```sh
export RAZBOR_CBM_BUNDLE=/absolute/path/to/codebase-memory-bundle
CBM_EXECUTABLE="$RAZBOR_CBM_BUNDLE/codebase-memory-mcp" pnpm run test:indexer
```

Docker and `postgres:17-alpine` are also required. The indexed integration and
retained-workspace refresh cases skip without `CBM_EXECUTABLE`. Each uses its
own database and source directory, reads no live credentials, and leaves
embeddings disabled.

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
