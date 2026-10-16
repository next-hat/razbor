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

The example config sets:

```toml
[runner]
concurrency = 1
timeout_ms = 3600000

[model]
max_requests = 512
max_retries = 3
max_output_tokens = 4096
timeout_ms = 3600000

[harness]
initialDiffMaxBytes = 4096
```

| Setting                       | Meaning                                                                                                                  |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `runner.concurrency`          | Reviews running at once.                                                                                                 |
| `runner.timeout_ms`           | Whole-attempt deadline; one hour by default.                                                                             |
| `model.max_requests`          | Total model-call ceiling, including compaction and final output. Range 1–512; default 512. Small reviews use at most 24. |
| `model.max_retries`           | Retries for transient HTTP errors and upstream timeouts. Range 0–10; default 3.                                          |
| `model.max_output_tokens`     | Maximum output requested per model turn.                                                                                 |
| `model.timeout_ms`            | Limit for each upstream request, including its response body. Default and maximum: one hour.                             |
| `harness.initialDiffMaxBytes` | Inline patch threshold for a single-group review. Grouped reviews inline bounded groups and page oversized patches.      |

Every request and retry is bounded by the time remaining in the attempt. A late
request does not get another hour. Incoming request uploads have a separate
60-second cap. Custom configs retain their explicit values; set
`model.timeout_ms = 3600000` if you want the current default. External proxies
must allow equivalent response timeouts; the Nanocl template allows one hour.

### Retries and usage

The provider relay honors `x-should-retry: false` and `true`. Without that header,
408, 409, 429, and 5xx responses are retryable. `retry-after-ms` takes precedence
over `Retry-After`; otherwise retries use bounded exponential backoff.
Cancellation and the attempt deadline apply during both requests and waits.
Policy rejections and oversized payloads are not retried.

For UI-configured reviewers, the control plane owns retries. The runner's
forwarding hop waits within the same deadline without retrying, and Mastra SDK
retries are disabled. Failed responses after exhausted retries carry
`x-should-retry: false`. Recovery after a timeout or non-rate-limit error marks
usage incomplete, since failed calls may have consumed unreported tokens.
Upgrade web and runner together to enable this behavior on both hops.

Rate-limit retries stay within one model turn. Waiting for a quota reset still
uses attempt time. Raising request or retry limits does not extend the deadline;
an attempt without a validated final result fails when its budget runs out.

### Large reviews and evidence

Full patch ingestion is capped at 32 MiB. Ordinary Git output and the changed-file
manifest are capped at 1,000,000 bytes. Pinned source blobs may be up to 32 MiB;
source pages are limited to 400 lines and 100,000 bytes. Diff pages remain bounded
by the tool output limit. Exceeding a Git cap fails with
`GIT_OUTPUT_LIMIT_EXCEEDED` without logging patch content.

Patches above 512 KiB or 96 files use deterministic file groups. Each group has
its own conversation, investigation, verification, and challenge checkpoints.
Oversized files stay paged. Groups share pinned commits and repository-wide
source access. A final pass checks cross-file contracts, reassesses candidates,
and rereads finding ranges before publication. Binary and unsupported changes
remain explicit limitations; unread content is never counted as reviewed.

The harness budgets up to 24 calls per group and reserves calls for final
verification, all within `model.max_requests`. Lower configured limits remain
in force and can produce an incomplete result. Large reviews can cost
substantially more; their time limit stays the same.

Upgrade the control plane before runners using these limits. Older control planes
reject more than 100 requests or a model timeout above five minutes. Lower runner
limits remain compatible but can be too small for grouped reviews or models using
high reasoning effort.

Before context exceeds the relay budget, synchronous Mastra compaction summarizes
older history in bounded chunks. Compaction shares the request budget, token
metrics, deadline, and cancellation. Instructions, current scope, and checkpoints
are retained; the source evidence ledger remains authoritative. Summaries help
navigation but do not count as proof. Invalid summaries or immutable context that
cannot fit make the review incomplete. Compaction adds no persistent memory,
hidden streaming calls, or separate retry budget.

The workflow shares one budget across investigation, verification, a challenge
pass even for zero-finding drafts, and completion. Workflow state belongs to the
attempt; the queue and attempt lease provide durable execution. The review guide
prioritizes changed production code, including maintained vendor code, before
test-only files. Checkpoints preserve each risk's contract and trigger, baseline
and head behavior, and downstream effects. Verification must address those same
contracts. The evidence gate checks source delivery and continuity; semantic
correctness and test expectations still need independent validation. A rejected
checkpoint gets one bounded revisit; unresolved gaps make the review incomplete.

Keep `model.supports_tools = true` for code reviews. Executable changes need pinned
source reads, and paged diffs need tools; a tools-disabled profile is rejected
before model requests in either case. Small inline documentation reviews can run
without tools. Staged reviews need at least four model turns; conversational
replies need at least one.

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
