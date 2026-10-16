# Review a pull request

Request a review with `/agentic_review` on a Forgejo or GitHub pull request, or a
GitLab merge request.

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
3. Choose an AI reviewer or use **Add agent**. Enter allowed command senders as
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
`reviewer_state`, plus the merge request reviewer state API. Older instances that
ignore these fields fail publication verification.

Forgejo and GitLab hooks are created automatically. **Webhook → Remote hook
setup** shows their callbacks and events. Forgejo needs pull request, pull request
comment, and push events; GitLab needs merge request, note, and push events. After
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

## Request your first review

1. Open a pull request or merge request in the connected repository.
2. From an allowed account, post a new comment with `/agentic_review` on its first
   line.
3. Look for a thumbs-up reaction or queued acknowledgement.
4. Follow queue, execution, and publication status in the razbor console.
5. Read the summary and inline findings on the pull request.

Opening a pull request posts a greeting without starting a review. A push to the
indexing branch refreshes the index without requesting one. Reviews and replies
use your model and may incur provider charges.

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

## Discuss a finding or request another review

Use **Reply** under a razbor inline finding to ask a question or dispute it.
No mention or command is needed. razbor answers in the thread using the original
review and available discussion. Sender restrictions still apply. Top-level
comments do not start these conversations.

Replies leave the review and summary unchanged. After fixing an issue or
discussing a possible false positive, post a new review command. The next review
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
Post the command again for the current revisions.

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
