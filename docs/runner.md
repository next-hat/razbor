# Runners

A runner accepts work for its assigned repositories and executes each review in
an isolated container. For a first installation, follow
[getting started](getting-started.md).

## Use the local Compose runner

The development stack registers **Local Compose runner** automatically:

1. Open **Runners → Manage**.
2. Assign repositories, or select **All repositories, including future ones**.
3. Assign an AI reviewer in each repository's **Settings → AI reviewer**.
4. Wait for **Ready**, then request a review.

The example has no repository assignments initially. The all-repositories option
also grants repositories added later; selecting every current repository does
not. Assignments survive restarts.

Compose uses [config/runner.example.toml](../config/runner.example.toml).
For custom settings, copy it to `config/runner.local.toml`, set
`RAZBOR_RUNNER_CONFIG=./config/runner.local.toml` in `.env`, and recreate:

```sh
docker compose up -d --force-recreate runner
```

Later edits to the same mounted TOML need `docker compose restart runner`.
Source changes need an image rebuild.

The optional `registration.repositories` list supplies initial assignments.
Use repository public IDs (`repo_...`) or configuration keys from:

```sh
docker compose run --rm manage repository list
```

Leave the list empty until repositories exist. Reprovisioning preserves the UI's
name, assignments, drain state, and revocation. Keep `registration.key`, the
registration volume, and job storage.

## Add a runner on another host

The execution host needs Linux, Docker, hardware virtualization, and the `kata`
runtime. Kata supplies the virtual machine boundary for the runner's inner
Docker daemon.

1. Build the matching image with `docker compose build runner`, then transfer
   `razbor-runner:0.1.0` through your registry or `docker save` / `docker load`.
   For a release image, use the matching tag from your
   [production deployment](deployment.md).
2. In **Runners → Register runner**, choose its name and repositories.
3. Set the app URL to an HTTPS origin reachable from the execution host.
4. Run the generated enrollment command there and wait for **Ready**.

The token expires after 15 minutes and works once. After enrollment, the runner
saves `/job-data/runner-state/identity.json`. Keep the `/job-data` volume or host
directory across restarts. The identity file uses mode `0600`, and its directory
uses `0700`.

Use `--enrollment-token-file PATH` to keep the token out of command arguments.
Optional TOML is selected with `--config PATH`. URL and token CLI options
override TOML; `RAZBOR_RUNNER_ENROLLMENT_TOKEN` also overrides the TOML token.
The original token is no longer needed after enrollment.

Give each host its own identity. Only one live process can use it; after an
abrupt restart, the previous session can take up to 90 seconds to expire.

## Change capacity and review limits

One autonomous agent chooses commands, source reads and optional capabilities.
There are no mandatory investigation phases, checkpoint JSON or model-generated
risk inventories. The final ReviewResult, prior-finding reassessment and existing
publication flow are unchanged. Finding locations are checked against regular
files and added-line hunks at the immutable recorded head, independently of the
source discovery tool. This validates locations, not semantic correctness.

```toml
[runner]
concurrency = 1
timeout_ms = 3600000

[model]
max_requests = 512
max_retries = 0 # opt in to bounded retries of known nonbillable rate rejections
max_output_tokens = 4096
timeout_ms = 3600000

[harness]
initialDiffMaxBytes = 4096
compactionThresholdTokens = 80000 # compaction trigger, not a hard context limit
# contextWindowTokens = 128000 # optional example: use the selected model's supported window

[harness.reviewBudget]
maxToolCalls = 2048
maxTokens = 1000000
maxOutputTokens = 4096
# maxCostUsd requires explicit, current prices for the exact assigned model.
```

`model.max_requests` bounds all model turns, including compaction, final output
and the single allowed correction of invalid final JSON. `harness.reviewBudget`
additionally bounds tool calls, cumulative input plus output tokens, and optional
estimated USD cost. Both output caps apply; the relay respects the lower cap.
There is no per-group budget multiplier.

The agent receives one updated remaining-budget notice and keeps room for a final
ReviewResult. Before a tool batch executes, the harness checks the whole batch and
its expected output against the remaining tool/token/cost limits and final-response
headroom. A refused batch executes no tools; each request receives an explicit
"not executed" result. If a final response is still affordable, the agent must
finalize with tools disabled and disclose incomplete inspection, unresolved prior
findings and unrun checks. If it cannot safely afford that response, the attempt
fails explicitly. No successful clean review is fabricated from exhaustion.

To enforce a monetary ceiling, configure `maxCostUsd` and verified prices under
`harness.reviewBudget.pricing`. A price entry includes `provider`, `model`,
`inputUsdPerMillion`, `cachedInputUsdPerMillion`, `outputUsdPerMillion` and
`cacheWriteUsdPerMillion`. Use TOML array entries
`[[harness.reviewBudget.pricing]]` to price multiple provider/model pairs. The
legacy single table `[harness.reviewBudget.pricing]` remains accepted; an omitted
provider means `openai`. Duplicate provider/model identities are rejected.

Prices are operator-supplied USD per million tokens; use zero for a category only
when it is not separately billed. Only an exact provider and model match supplies
cost estimates. Without a matching entry, an uncapped review continues with token
and tool limits and no cost estimate. A monetary cap requires a matching entry and
fails before a model dispatch when none exists. Agent profiles continue to choose
the model and reasoning effort through the existing configuration.

Budget admission reserves conservative input and a full capped output before each
dispatch. Its serialized-byte allowance and overhead are deliberately separate
from the rough context-compaction estimate; when provider prompt measurements
exist, new serialized bytes retain a conservative allowance. Complete provider
measurements settle the reservation. Missing or failed responses retain
conservative charges and mark usage incomplete. Cached, uncached, output and
separately billed cache-write categories remain distinct.

The existing execution log shows available per-attempt categories and USD
estimates, labeling conservative estimates. Attempt metrics use existing JSON
storage and survive failed reviews; no database migration is required. Use matching
web and runner versions for the new telemetry fields; older strict APIs may
reject them. Existing saved reviews and legacy metric records remain readable.

### Requests, isolation and command exploration

The SDK does not retry model requests. Relay throttle retries are opt-in through
`model.max_retries` (default 0; range 0–10). A positive value permits only bounded
retries of known pre-generation rate rejection envelopes: OpenAI
`rate_limit_exceeded` / `slow_down`, or Claude `rate_limit_error` with a valid
provider retry delay (its monthly spend-cap errors share the same type). A 429 status,
`Retry-After` or `x-should-retry: true` alone is insufficient. Permanent quota,
billing or subscription errors, unknown compatible-provider/Azure error shapes,
usage-bearing errors, authentication errors, 5xx, transport failures and timeouts
are never automatically retried. `x-should-retry: false` always disables retry.
Classification assumes these documented rate errors rejected generation; it does
not establish a provider billing guarantee for arbitrary compatible endpoints. See
the [OpenAI error categories](https://developers.openai.com/api/docs/guides/error-codes),
[Claude429/spend-cap distinction](https://platform.claude.com/docs/en/api/errors),
and [Azure429 guidance](https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/quota).

Known throttle retries honor `retry-after-ms` / `Retry-After`; without a valid
hint a recognized OpenAI rate rejection uses bounded exponential backoff. Claude
rejections without a valid delay remain ambiguous and are not retried. Shared quota
pacing still applies.
One fixed `model.timeout_ms` deadline covers quota waits, all retries and the
response body, bounded further by the whole-attempt deadline. Cancellation or
revocation interrupts backoff before another dispatch. Retry diagnostics expose
only safe classifications and counts. The retry limit counts extra rejected
upstream requests within one model turn; it does not authorize another billed
generation. A final-JSON correction remains an explicit budgeted model turn.

Exec accepts an argument vector and a repository-confined working directory.
Installed git, rg, grep, cat, sed, awk, head, tail and find can inspect the checkout;
existing test/build tools can verify behavior. Optional read_file/read_diff tools
provide pinned pages. Normal command exploration needs no graph or skill call.
Unavailable optional CBM/MCP/memory services produce explicit limitations.
Approved instruction or skill loading failures remain fatal.

Commands keep the existing Kata/container boundary, resource limits, sanitized
environment, bounded output, cancellation, deadline and process-group cleanup.
Exec is not a host shell or a new filesystem/network sandbox: the existing
non-root job container and internal job network enforce those boundaries.
Source objects are imported into a fresh checkout without forge credentials or
host infrastructure sockets. Availability of command-line programs depends on
the configured agent image; missing utilities are failed checks, never passes.

### Context and large comparisons

Full patch ingestion is capped at 32 MiB. Ordinary Git output and the changed-file
manifest are capped at 1,000,000 bytes. Pinned source blobs may be up to 32 MiB;
source pages are limited to 400 lines and 100,000 bytes. Diff pages remain bounded
by the tool output limit. Exceeding a Git cap fails with
`GIT_OUTPUT_LIMIT_EXCEEDED` without logging source content.

One automatic compaction mechanism uses `harness.compactionThresholdTokens`
(default 80,000) as a trigger for reducible investigation history. It is not a hard
context limit. Large immutable inputs do not fail merely because they exceed the
trigger; initial source context is not replaced with a lossy note before the
first model request. The trigger can rise above the immutable context, and
compaction runs only when it can preserve final-response headroom.

Context estimates use measured provider prompt tokens plus estimated new history,
or serialized UTF-8 bytes divided by three when measurements are absent. Tool
definitions and request overhead also count. These are planning heuristics, not
exact tokenization or the conservative byte allowance used for budget admission.
Optionally set `harness.contextWindowTokens` to the supported context window of
the selected model. Every dispatch, including compaction, checks estimated input
plus the capped output against that separate configured window. Summary fragments
shrink to fit their entire estimated request, including the previous note, prompt
and reference list. The provider still enforces its actual token limit.

Compaction preserves the stable system instructions, exact complete changed-file
manifest, revision identities, previous-finding obligations and environment facts.
Older investigation history becomes one bounded continuation note preserving
relevant discoveries, observation references, unresolved hypotheses, failed/unrun
checks, inspection limitations and next steps. Tools-disabled profiles keep their
exact inline comparison and do not replace it with compressed evidence they
cannot reread.

Oversized history is summarized in sequential bounded fragments through the same
model, budget and cancellation signal. Complete tool outputs are consumed once,
not replayed after compaction; no duplicate evidence ledger or checkpoint JSON is
injected. Unknown references, incomplete notes or an immutable request envelope
that cannot fit the configured window fail explicitly. Notes cannot prove a
finding or a passing check. Important source evidence must be reread when needed.
No new persistent state is introduced.

The agent decides how to investigate large comparisons and must disclose any
uninspected scope. Optional diff-delivery counters measure content supplied by
read_diff; they do not measure inspection through commands or semantic coverage.
Tools-disabled models can review a complete inline comparison, but a lazy diff
requires tools. No minimum four-turn workflow remains.

### Model configuration

The repository's assigned AI reviewer supplies the endpoint, model, and API key.
The local `model.endpoint`, `model.api_key`, and `model.model` fallback must be set
together; it only applies when no reviewer is assigned. Use
`model.provider = "anthropic"` for a native endpoint ending in `/messages`.
The default, `openai`, uses `/responses`.

Saved profiles choose a provider and reasoning effort: Low, Medium, or High, with
High as the default. OpenAI-compatible reviews save that effort when submitted,
so queued reviews keep it after a profile edit. It overrides the runner's
`model.reasoning_effort`, which also defaults to High. Reviews without a saved
effort use the runner value. The setting does not translate into Anthropic
thinking or effort options. Upstream credentials stay in the control plane or
runner; agents receive only a revocable attempt credential.

### Available tools

Before investigation, Razbor checks executables on the approved PATH and detects
common root manifests. It does not execute project scripts or install toolchains.
Logs and model context report missing tools, and reviews must distinguish source
inspection from checks that ran.

The standard Node agent image has no Cargo. For build verification, choose a
trusted agent image with the needed toolchain; installing it on the outer runner
does not add it to the agent. The checkout is read-only, and temporary storage is
bounded and non-executable, so an installed tool alone does not mean a build can
run. Rust commands default to two compilation jobs and two test threads within
the container CPU quota.

See [repository settings and skills](skills.md) for approved instructions. The
example TOML also shows how to mount operator-owned instruction files.

## Drain, revoke, or replace credentials

Use **Runners → Manage**:

- **Drain** stops new work and lets reserved work finish. **Resume** accepts work.
- **Revoke** invalidates the credential and session. Disconnected work stops when
  its lease expires; revocation is not an immediate remote kill.
- **Replace credentials** issues a new token and invalidates the old credential
  and session while keeping the runner record and storage.

For a Compose runner:

1. Run `docker compose stop runner`.
2. Choose **Replace credentials** and set the new token as
   `RAZBOR_RUNNER_ENROLLMENT_TOKEN` in your private `.env`.
3. Run `docker compose up -d --force-recreate runner`.
4. After enrollment succeeds, remove the token override. Later starts use the
   saved identity.

For another host, run the new generated command with its existing storage. If
storage was lost, use **Replace credentials** to enroll again. Do not copy another
host's identity.

## Troubleshooting

Check **Runners** and the review's progress log first. For Compose:

```sh
docker compose ps -a
docker compose logs --tail=100 runner-registration runner
```

| Symptom                                | Check                                                                 |
| -------------------------------------- | --------------------------------------------------------------------- |
| Ready runner, queued review            | Repository assignment and AI reviewer assignment.                     |
| Runtime unavailable                    | Docker/Kata installation and runner logs.                             |
| Update required                        | Transfer or rebuild the runner image matching the app.                |
| Duplicate/live session                 | Stop the other process and allow its session to expire.               |
| Unknown initial assignment             | Use `repository list`; correct its ID/key or set `repositories = []`. |
| Missing/mismatched registration secret | Restore the matching registration volume.                             |
| Model 429 or deadline failure          | Provider limits, review progress, and the settings above.             |
| DNS failure inside Kata                | Use a resolver file with reachable, non-loopback servers.             |

The resolver defaults to `/run/systemd/resolve/resolv.conf`.
Set `RAZBOR_RUNNER_NETWORK_PREFIX` if the development subnet `172.30.250.0/24`
conflicts with your network. The production Compose example uses
`172.30.251.0/24`.

### After deliberately resetting the database

Use this only when a database reset removed registration but kept job storage.
Ordinary restarts and credential replacement must keep the saved identity.

1. Clear invalid `registration.repositories` entries or set the list to `[]`.
2. Stop the runner.
3. Back up and move aside only `runner-state/identity.json` under
   `RAZBOR_STORAGE_HOST`. Keep other job data and the registration volume.
4. Start the stack to provision the new runner record.
5. If startup reports `Enrollment belongs to a different saved runner identity`,
   use **Replace credentials** on the new record and the token override above.
   The previous token may have been consumed.
6. Recreate repositories and assign them to the new runner.

## Storage and isolation

The outer runner uses Kata. Its private Docker daemon starts non-root agents with
`runc`; the host Docker socket is never mounted. Compose limits the runner to
four CPUs, 6 GiB RAM, 2048 PIDs, and 4 GiB temporary Docker storage. Per-agent
limits are set in TOML.

Runner images bundle checksum-pinned ripgrep 15.2.0 for Linux amd64 and mount it
read-only at `/usr/bin/rg` in agents. The default `node:24-bookworm` agent image
also supplies GNU `grep`. A standalone runner may supply a trusted `bin/rg` under
`storage.runtime_root`; the binary and its parent must be regular, without
symlinks. Without that optional binary, it uses the agent image's search tools.

`docker.uid` and `docker.gid` in TOML default to 1000. Compose's `RAZBOR_UID` and
`RAZBOR_GID` configure the indexer, not the runner. Startup changes the job
directory's owner before dropping privileges. If needed, set the TOML IDs from
`id -u` and `id -g` before first use and ensure storage is writable. Changing the
IDs later does not update ownership of existing files; back up and adjust those
deliberately.

The app supplies source, model access, and index access per attempt. Runners need
no shared database, forge, or index-management credentials. Limit HTTP enrollment
to the local development network and use HTTPS remotely.

Results, bounded progress logs, and the pg-boss queue live in PostgreSQL. See
[data and recovery](persistence.md) for backups and [tests](../tests/README.md)
for runner checks.
