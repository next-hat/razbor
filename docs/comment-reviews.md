# Review a pull request

Razbor can review Forgejo and GitHub pull requests and GitLab merge requests on
command or in response to authenticated pull request events.

You need a running [installation](getting-started.md), an assigned
[runner](runner.md), a reviewer configured in **Agents**, and an HTTPS webhook
address reachable by your Git provider.

## Connect a repository

1. Open **Repositories → Connect repository** and choose a provider. On GitHub,
   choose **GitHub App (recommended)** or **Manual webhook and access token**.
   Forgejo and GitLab need a dedicated bot account and token with the
   [permissions below](#provider-permissions).
2. For token setup, enter the repository URL and token, then **Check access and
   continue**. This reads identity, repository, and branch details without saving
   credentials or creating a webhook. Use **Instance and branch options** for
   overrides. If a self-hosted provider runs under a path, set its **Instance
   URL**, for example `https://git.example.com/gitlab`. Keep GitLab groups and
   subgroups in the repository URL.
3. Select a **Review trigger mode** and choose an AI reviewer or use **Add agent**. Enter allowed command senders as
   comma-separated provider usernames, such as `alice, bob`. Adding an agent
   saves it immediately, even if you cancel repository setup. Enter your public
   HTTPS origin as the webhook callback base; `RAZBOR_WEBHOOK_CALLBACK_BASE`
   prefills it. GitHub App setup asks for this address before creating the App.
4. Check the summary and select **Connect repository**. Complete manual GitHub
   hook setup below; Forgejo and GitLab hooks are automatic. Check index readiness,
   hook configuration, and delivery separately. A ready index does not confirm
   webhook setup. Retry failed setup without creating another registration.
5. In **Set up a runner**, assign an existing runner or register a new one. This
   repository is preselected, and existing assignments are preserved. Registration
   shows a one-time enrollment command for the runner host. Follow
   [runner setup](runner.md) and wait for an assigned runner to become available.

**Runner default** supports existing installations with model credentials on the
runner. Setup does not check those credentials. Select an AI reviewer if the
runner has no fallback model.

Request reviews from a separate account: razbor ignores its bot's comments.
GitHub pull requests must be open. For a closed or merged pull request, an allowed
user's command gets an explanation instead of a review. Reopen an unmerged pull
request or use a new one.

Tokens cover provider API calls and HTTPS Git checkout; no SSH key is needed.
The review agent does not receive the token. Keep the same bot identity when
rotating a personal token so razbor recognizes its existing comments.

The sender value `*` permits any commenter only while the provider confirms the
repository is private. Public repositories require explicit usernames. Tokens,
GitHub App private keys, and webhook secrets are plaintext in PostgreSQL; protect
the database and backups.

### GitHub App setup

Select **Create your own GitHub App**, enter a name and callback base, then
**Create App on GitHub**. Create a private App for each razbor deployment. The
manifest flow supplies permissions, events, and URLs. Approve creation under your
account or organization, install the App, and select its repositories. Back in
razbor, choose the installation and repository. Organization policy may require
an owner's approval.

You own the App. Its private key and webhook secret return to this razbor
instance, which receives events and publishes as the App's bot. There is no
centrally operated razbor App or service. razbor creates temporary installation
tokens as needed and scopes repository work to that repository. This flow needs
no separate bot account or personal access token.

To add another repository, select a saved App. Use **Install App / manage access**
to change its repository selection, then **Refresh repositories**. This flow
cannot import arbitrary existing App credentials. GitHub.com, GitHub Enterprise
Server, and Enterprise Cloud data residency instances use the configured provider
origin.

The callback base must be public HTTPS reachable by GitHub. The browser return
URL uses the console address, which can remain private through localhost or an
SSH tunnel. Keep the same console address and signed-in browser session during
creation. Configure a reviewer and assign a runner separately before requesting
a review.

### GitHub manual webhook setup

Choose **Manual webhook and access token**, enter the repository URL and personal
or bot token, then check access. The token needs **Contents: read**, **Pull
requests: write**, and **Issues: write**. It does not need **Webhooks: write**;
create the hook using an account with webhook management access.

Copy the exact callback URL and generated secret from the finish screen. The
secret is shown once. In GitHub, open **Settings → Webhooks → Add webhook**:

- Set the payload URL to the displayed callback and choose **application/json**.
- Paste the secret, leave SSL verification enabled, and activate the hook.
- Select `pull_request`, `issue_comment`, `pull_request_review_comment`, and `push`.

GitHub sends a signed ping on creation. razbor marks the hook ready after a valid
delivery for the registered repository. If the ping fails, fix the callback or
secret and redeliver it from GitHub's log. The repository's **Webhook** settings
retain its URL and events. Never reuse a deleted registration's callback URL.

Remove this remote hook yourself when deleting the razbor registration. Existing
GitHub registrations with razbor-managed hooks keep automatic setup and cleanup.

### Provider permissions

**Forgejo:** give the bot repository admin permission and a personal access token
with `read:user`, `write:repository`, and `write:issue`. Instance admin access is
not required. On Forgejo v15, choose **All (public, private, and limited)** for
token repository access; repository-specific tokens cannot administer hooks.

**GitHub App:** the manifest requests **Contents: read**, **Pull requests: write**,
and **Issues: write**, plus GitHub's built-in App metadata access. Creation also
configures events.

**GitHub manual webhook:** grant **Contents: read**, **Pull requests: write**,
and **Issues: write**. Older registrations with automatic hooks also need
**Webhooks: write**. Select the correct GitHub instance during setup.

**GitLab:** use a bot personal or project token with `api` scope and Maintainer
access for automatic hook setup. razbor uses the webhook's **Secret token**.
The instance must support Draft Notes publication with a summary and
`reviewer_state`. GitLab accepts no expected revision on bulk submission and can
downgrade a request for changes to a comment. Razbor checks the revision and
required readiness immediately before and after submission. For a request for
changes, it also checks the bot's approval permission before sending and the
returned reviewer state immediately afterward. GitLab cannot rule out a change
and reversal between these observations. If the response is lost or Razbor
cannot verify the outcome, the console and reconciled summary show the verdict
as **unconfirmed**. An unconfirmed follow-up keeps the full result in its own
summary, including findings without inline anchors. Later reviews recognize
verified inline notes and avoid posting them again. Recovery never resends the
bulk request. [GitLab Draft Notes API](https://docs.gitlab.com/api/draft_notes/#publish-all-pending-draft-notes)

If a worker stopped at the bulk POST and reconciliation cannot find the summary,
inspect the MR and its drafts using the original bot account. To stop retrying
that review, substitute its review ID in the command below.

```sh
docker compose run --rm manage review abandon-gitlab-publication rev_ABCDEFGHIJKLMNOP
```

Older submissions may lack a saved bot ID. If GitLab has no visible summary,
verify which bot submitted the original review, restore that bot's credential,
and append `--original-bot-id <numeric-user-id>` to the command. The command
checks the supplied ID against the authenticated GitLab account.

An `abandoned` outcome removes identifiable unpublished drafts owned by that
review and records the verdict as unconfirmed. A visible marked summary yields
`submitted` and the dispatcher continues normal reconciliation. An `ineligible`
result means the command found no ambiguous GitLab bulk to abandon or could
not confirm its owning identity. A `busy` result means another interaction is
running for that repository. The command never posts a verdict. GitLab may
still complete an earlier request after the operator stops reconciliation.

Before submitting, Razbor lists the bot's drafts again and checks their IDs,
text and positions against the reviewed findings. GitLab publishes all the bot's
drafts on the MR and accepts no expected draft list. Give Razbor its own bot
identity when other tools would otherwise write drafts under that account.

If a review becomes stale after a GitLab draft creation was interrupted, Razbor
checks the bot's complete draft list. For a create without a returned ID, it
requires two empty observations for that draft at least 30 seconds apart before
releasing it. A draft that appears between checks is verified and deleted by ID.
GitLab provides no creation receipt for a draft POST whose response was lost.
A draft that GitLab exposes only after both observations can remain on the MR.

Forgejo and GitLab hooks are created automatically. **Webhook → Remote hook
setup** shows their callbacks and events. Forgejo needs `pull_request`,
`pull_request_sync`, `pull_request_comment`, and `push`. GitLab needs merge
request, note, and push events. After
fixing permissions, retry setup without deleting the registration.

## Public webhook proxy

The console and webhooks share the web app's port. To expose callbacks while
keeping the console private, bind the app to `127.0.0.1` and publish only
`/webhooks/`. Include `/api/runner/` if remote runners need broker access.

Add a server like this to the host's Nginx configuration. Replace `3000` if you
changed `RAZBOR_WEB_PORT`.

```nginx
server {
    listen 127.0.0.1:8081;
    server_name _;
    client_header_timeout 10s;
    large_client_header_buffers 2 8k;

    location /webhooks/ {
        client_max_body_size 1m;
        proxy_read_timeout 750s;
        proxy_pass http://127.0.0.1:3000;
    }

    # Keep this location only if remote runners need it.
    location /api/runner/ {
        client_max_body_size 10m;
        proxy_read_timeout 750s;
        proxy_buffering off;
        proxy_request_buffering off;
        proxy_pass http://127.0.0.1:3000;
    }

    location / {
        return 404;
    }
}
```

Leave `proxy_pass` without a trailing slash to preserve callback paths. Push
webhooks can wait for indexing, so they need the longer response timeout.

For local development, load the Nginx configuration and run:

```sh
ngrok http http://127.0.0.1:8081
```

Use the tunnel's HTTPS origin as the callback base. Tunnel filtered port `8081`,
rather than the app port. For permanent HTTPS, use the same locations in your
TLS server block.

Before enabling deliveries, check the app and proxy:

```sh
curl --fail-with-body http://127.0.0.1:3000/health
curl -i http://127.0.0.1:8081/
curl -i http://127.0.0.1:8081/api/repositories
```

Health should succeed; both proxy requests should return `404`. Check the blocked
paths through the public HTTPS address too. razbor verifies deliveries with the
provider's configured secret.

## Review trigger modes

Choose a mode in the connection wizard or **Repository → Settings → General**.
For a file-managed repository, set `reviewTriggerMode` under
`[repositories.<key>]` and apply the registry.

| Mode                                       | When Razbor queues a review                                                                                                                                                                         |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Manual (`manual`, default)                 | A permitted user posts a new comment with `/agentic_review` on its first line. Repeat the command for another review.                                                                               |
| On-demand continuous (`opt_in_continuous`) | The first permitted command queues a review and opts that PR into reviews of subsequent source changes. The opt-in survives restarts. Closing or merging ends it. Reopening requires a new command. |
| Fully automatic (`automatic`)              | Opening or reopening a ready PR, marking a draft ready, or pushing a new revision can queue a review. On public repositories, the PR author must be named in the permitted senders list.            |

Explicit commands can request another review of the same revision in every
mode, including on open drafts. Inline replies continue their existing finding
discussion. If the forge timestamps a command in exactly the same instant as a
session reset, Razbor queues the explicit review. A later command can activate
continuous review unambiguously. The PR detail page shows an active opt-in.
Changing modes ends previous opt-ins. A policy change applies to
subsequent events and preserves review history. All three modes work with
source-only and indexed checkouts. Each review can consume inference tokens and
incur charges from the configured model provider.

For fully automatic reviews, Razbor reads the target repository’s current
visibility and the PR author from the forge. On a public repository it compares
the author's login to explicit entries in `permitted_senders` case-insensitively.
The `*` entry cannot authorize a public PR author. A permitted user can still
request a review of a contributor’s PR with `/agentic_review`. When the forge
reports private or internal visibility, fully automatic mode covers ready PRs
from any author, including contributors outside the sender list.

GitHub sends `pull_request` actions, including `synchronize` and
`ready_for_review`. Retargeting a PR to another base branch also triggers a
revision check. Title and description edits alone do not queue a review.
GitLab sends merge request events, including updates with a
previous source revision or draft transition. If GitLab is still preparing the diff
when an MR opens, is updated, or becomes ready, Razbor retries the delivery and
checks the current revision and policy before queueing work. A verified close or
reopen ends the previous opt-in even while the diff is being prepared.
Forgejo sends pull request
lifecycle events and a separate synchronization subscription for source updates.
For that subscription, Forgejo sends `pull_request` in `X-Forgejo-Event` and
`pull_request_sync` in `X-Forgejo-Event-Type`.
Forgejo reports title edits with the resulting draft flag. Renaming an already-ready
PR at the same recorded revision leaves its review history alone. When Razbor first
observes a PR through such an edit, a verified ready revision can trigger its first review.
Razbor verifies the repository and reads the current PR before queueing an
automatic review. Providers must report draft status for automatic admission.
A multi-commit push reviews the resulting head against its merge base. Forks are
fetched from the configured target remote using `refs/pull/<number>/head` on
GitHub and Forgejo, and `refs/merge-requests/<iid>/head` on GitLab.
Default-branch push events still refresh enabled indexes.

The delivery ID, trigger, and queue entry are recorded in PostgreSQL. Another
delivery for a revision already queued, running or completed for that PR does
not start a second automatic review. Later pushes replace the head and base of
an unstarted automatic review. If an attempt is running, its revision stays
pinned and the latest pending revision waits. Manual commands can request an
additional review. When a review is waiting for a runner, assigning an eligible
runner and reviewer lets the same review proceed. Before publishing findings,
Razbor checks the current source and target revisions and any newer published
decision. If a previously reviewed revision becomes current again, a saved
result that was safely withheld as stale can be published without another model
call. If a delivery fails, redeliver it from the forge. Razbor records a close
or reopen before reading review history. Redelivery resumes that work. If a
closed-PR command was already declined, redelivery reconciles the explanation
even if the PR has since reopened.

Provider references cover
[GitHub pull request events](https://docs.github.com/en/webhooks/webhook-events-and-payloads#pull_request),
[GitLab merge request events](https://docs.gitlab.com/user/project/integrations/webhook_events/#merge-request-events),
and [Forgejo v15 webhook types](https://codeberg.org/forgejo/forgejo/src/tag/v15.0.0/modules/webhook/type.go).

Follow a queued review in the console. A temporary top-level comment identifies
the commit while Razbor waits for an eligible runner and reviewer. Once the
attempt starts, Razbor edits the same comment. The bot needs permission to read,
create, edit and delete its own issue comments (GitHub and Forgejo) or merge
request notes (GitLab). Set `RAZBOR_PUBLIC_URL` to the HTTPS console origin
to include a review-page link. If final publication takes time, the existing
comment shows that publication is pending. Razbor removes the comment once the
outbox confirms the result, failure message or stale outcome. The final result, failure messages and discussions remain.
If the provider is unavailable or a write response is lost, the durable outbox
retains the state needed to reconcile the bot-owned marker. A lost create
response can delay status updates until the comment appears. During cleanup,
Razbor checks the full comment list again after 30 seconds if the bot's marker
is missing. Two complete reads without the marker finish cleanup. A fast review
may finish before the status worker posts a comment.

If a temporary comment disappears while the review is queued or running,
Razbor detects it on the next status update. Once a complete PR comment listing
confirms its absence, Razbor can post a replacement for the still-active review.

After a bot account change, each existing comment retains its original owner.
New reviews use the newly configured bot. For an existing review, restore the
original credentials and reconcile the webhook, or have the owner remove the
temporary comment on the forge. While the old comment is visible, Razbor checks
the PR hourly and leaves the comment in place. Once the old comment is gone,
an active review can post a replacement under the new account.

Repository deletion waits for temporary comment cleanup before discarding
credentials. If the forge is unavailable or rejects a delete, restore
connectivity or the bot's permissions. Razbor retries with the saved identity.

## Read the result

A review with findings includes a change summary, reviewed commit, severity counts, and
expandable findings. Each finding describes an issue, its trigger, and a
suggested fix. Findings that fit changed lines appear inline; others stay in the
summary. The first review with actionable findings requests changes.

Inline findings include **Prompt your agent**, a copyable request with the
location, explanation, and fix instructions. Safe localized replacements may
appear as snippets. Forgejo snippets are display-only, with no apply-suggestion
action. Optional change diagrams depend on the provider's Mermaid support.

When no new or outstanding findings remain, razbor posts a short congratulations
comment. The neutral result does not approve or merge the pull request or replace
required checks. On Forgejo, it also leaves any earlier change request in place.

### Deletion-only changes

Inline findings currently require a location in one recorded head-side diff hunk
ending on an added line. The shared publisher applies this limit for GitHub,
GitLab and Forgejo. Removing a guard or deleting a whole file can therefore leave
no eligible inline location, even when baseline inspection demonstrates a defect.
The agent can inspect removed source at the baseline revision, but must never
invent an added line or move a finding to an unrelated change. Report the concern
and its baseline evidence explicitly as a head-side contract limitation in the
summary. If the returned findings still contain an unsupported location after
correction, validation leaves the attempt incomplete. Summary limitations remain
in the saved review and console; when no structured or outstanding findings
remain, the provider recap keeps its existing short congratulations format and
does not display that summary.

Older saved findings that reach publication without an eligible anchor remain in
the review recap with a location limitation. They are preserved as findings and
are not converted into a clean review. The added-line publication limit predates
the autonomous harness; validating it inside the harness now rejects unsupported
locations earlier in the attempt.

Deletion-side findings need a separate, bounded follow-up: explicitly represent
the source revision and diff side, validate baseline paths and ranges against
immutable Git objects, update GitHub, GitLab and Forgejo anchor translation and
source links, and cover deleted guards and whole-file deletions in provider
fixtures. This follow-up requires a review-contract decision; current finding
fields and publication APIs retain their existing head-side meaning.

## Discuss a finding or request another review

Use **Reply** under a razbor inline finding to ask a question or dispute it.
No mention or command is needed. razbor answers in the thread using the original
review and available discussion. Sender restrictions still apply. Top-level
comments do not start these conversations.

Replies leave the review and summary unchanged. After fixing an issue or
discussing a possible false positive, a new review command explicitly requests
a re-review in any mode. The next review
checks earlier findings alongside the current changes:

- **Open** and **uncertain** findings stay in the summary.
- **Resolved** findings leave the outstanding list after explicit assessment,
  including findings disproved by inspected source.
- Existing comments and discussions remain. Earlier findings are not reposted
  as new inline comments.

Repeat reviews with outstanding findings update the original summary. New
findings may get inline comments. Forgejo publishes those as a neutral review;
GitHub and GitLab retain a request-changes result. A repeat containing only
existing open or uncertain findings updates the summary without another native
review.

Resolved inline findings get a confirmation reply. GitHub and GitLab also resolve
the thread. Forgejo leaves it open because its API adapter lacks resolution.
Summary-only findings are reassessed but have no thread to update.

If base or head commits change before publication, razbor reports a stale review.
A manual command requests a fresh review. Active continuous policies also
respond to source revision events.

## Troubleshooting

| Problem                                | What to check                                                                                                                     |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| No reaction to a command               | Put the command on the first line, use an allowed account other than the bot, and inspect webhook deliveries.                     |
| Webhook setup failed                   | Check permissions, callback URL, and public HTTPS. Retry managed setup; fix manual GitHub hooks in GitHub and redeliver the ping. |
| GitHub App repository is unavailable   | Confirm installation, access to the repository, and that the App is not suspended. Refresh the repository list.                   |
| "Awaiting first delivery"              | Send a review command or redeliver an event; configuration is ready but no event has arrived.                                     |
| Review stays queued                    | Check for a Ready runner assigned to the repository. See [runner troubleshooting](runner.md).                                     |
| Index is not ready                     | Check the repository's Index settings and indexer logs. See [indexing](indexing.md).                                              |
| Push delivery timed out                | Check whether indexing is still running. Redeliver the hook to retry a failed or interrupted refresh.                             |
| Review completed but was not published | Check publication status, provider permissions, and whether pull request commits changed during the run.                          |
| Reply did not start a conversation     | Use a razbor inline thread, not a top-level comment.                                                                              |

## Existing file-managed repositories

Older TOML registrations still work. Keep token and webhook-secret file mounts;
their webhook fields are read-only in the console. To import a registry, set
`RAZBOR_REGISTRY_CONFIG` and run:

```sh
docker compose --profile registry-import run --rm registry
```

Startup does not repeat the import. Remove deleted TOML entries before importing
again to keep them absent. Read [persistence](persistence.md) before changing
checkout storage or credentials.

Deleting a registration removes local history, repository credentials, checkout,
index, and any razbor-managed repository hook. Operators must remove manual
GitHub hooks. Shared GitHub App installations stay available for other
repositories. Remote repositories and published comments remain. Retry failed
setup without deleting the registration.
