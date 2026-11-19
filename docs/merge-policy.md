# Merge policy and human review

Open **Repository → Settings → Merge Policy** with repository management access. Choose the confidence threshold, merge method and candidate reviewers, write the Markdown policy, and save. File-managed repositories display their settings read-only. Review triggering remains a separate setting. A console request, an authorized comment command and an automatic code review all use the repository policy captured at admission. Conversational replies cannot authorize a merge.

Automation starts disabled. Enable it with **Dry run** selected to post a confidence report for a completed review of a verified repository's current, open, ready-for-review PR. Razbor updates one bot-owned comment with the reviewed commit, confidence score, threshold, risk, and reasons for its decision. A settled dry run sleeps until the review, revision, or policy changes. Pending checks and unconfirmed writes have their own retry deadlines.

For approval without merge scheduling, leave **Dry run** on and select **Automatically approve eligible revisions on the forge**. This casts a real vote on a supported forge after the review and approval checks pass. The comment reports the approval separately from merge eligibility. Keep automatic approval off for comment-only dry runs. To enable native merge scheduling, configure the provider protections and turn dry run off. When both actions are enabled, Razbor requires a confirmed approval and separately checks native merge eligibility before it schedules the merge. GitLab supports guarded native scheduling. On GitHub and Forgejo, maintainers complete the merge. Every policy change requires a fresh review.

## Settings

| Setting                | Default | Effect                                                                                                                                     |
| ---------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `enabled`              | false   | Enables triage comments and the selected approval and merge actions. The console can still show assessments while disabled.                |
| `dryRun`               | true    | Publishes confidence and reasons. Native merge scheduling and eligibility-check release stay off.                                          |
| `autoApprove`          | false   | Authorizes the forge bot to approve the reviewed revision under an enabled policy, including in dry run.                                   |
| `minimumConfidence`    | 90      | Inclusive integer threshold from 0 through 100.                                                                                            |
| `mergeMethod`          | squash  | Requested provider method. An unavailable method blocks automation.                                                                        |
| `requirePassingChecks` | true    | Requires verified passing checks. Provider rules and the adapter’s safeguards apply for either setting.                                    |
| `defaultBranchOnly`    | true    | Only the verified default branch is implemented as an allowed destination. Turning this off grants no additional branches in this release. |
| `policyMarkdown`       | empty   | Up to 32 KiB of UTF-8 project-specific guidance.                                                                                           |
| `humanReviewers`       | empty   | Up to 24 individual provider usernames with responsibilities and optional display label, path patterns and risk categories.                |

For a file-managed repository, add the following to its **trusted deployment registry** and run the existing registry import. The document is inline in the registry. Reviewed source branches cannot supply their own policy.

```toml
[repositories.platform.mergePolicy]
enabled = true
dryRun = true
autoApprove = false
minimumConfidence = 95
mergeMethod = "squash"
requirePassingChecks = true
defaultBranchOnly = true
policyMarkdown = """
## Escalation
Send authentication, schema migrations and payment changes for human review.
For documentation corrections, verify affected examples and links.
"""

[[repositories.platform.mergePolicy.humanReviewers]]
username = "alice"
label = "Database maintainer"
responsibilities = "Schema design, migrations and rollback"
pathPatterns = ["db/**"]
riskCategories = ["persistence"]
```

Source patterns are case-sensitive and relative to the repository root. Within one path component, `*` matches any number of characters and `?` matches one. A whole `**` component spans directories, including hidden ones. For example, `db/*.sql` covers SQL files directly under `db/`, and `db/**` covers every file below it.

## How a decision is made

The model receives the saved policy and allowlist in both indexed and source-only reviews. Confidence is an **uncalibrated model assessment of merge readiness**. A score of 95 is not a 95% probability of correctness. Repository managers can inspect the detailed assessment evidence, commands and verification gaps on the review. Members see the score, risk and service-generated decision reasons. Forge escalation comments use service-generated reasons and the verified reviewer names. A complete, low-risk review still needs a matching policy version and revisions, no actionable or outstanding findings, and provider permission to merge.

For automatic approval or merge, the harness must have supplied the complete patch for every changed text file and metadata-only change. Inline diffs, completed `read_diff` pages and matching untruncated Git output for the reviewed commits count. A file list, a head-only source read or a partial patch leaves a verification gap and routes the PR to human review.

New code reviews include a structured assessment. Historical results without one cannot authorize merging.

If you ran an earlier Phase 3 preview, disable automation before upgrading, then re-enable it and request fresh reviews. The policy version change invalidates assessments recorded before patch coverage was enforced.

The server reconciles published findings, including open and uncertain findings from earlier runs, before checking the forge. High or critical risk, affected critical areas, incomplete investigation, and an explicit request for human review all require a human. Markdown can explain project criticality. The server owns authorization and enforces the saved structured policy and provider protections.

A review started from a PR in the console can also leave outstanding findings. A later review of that PR receives their saved identities and can mark each occurrence resolved with evidence. When the findings exceed the context limit, run the verification batches on the same final PR revision. If the revision changes between batches, repeat the earlier console checks on the new revision. Every occurrence still counts in the merge decision until it has a matching resolution. A single historical finding larger than the entire context limit continues to require human review.

Razbor ranks owners whose patterns match the pinned Git comparison first. A deleted file uses its original path, and a rename can select owners of both paths. The next candidates are allowlisted people suggested by the model or matched by a risk category. Configuration order breaks ties within each group. Reviews completed before path matching was available use their recorded assessments; a fresh review computes path ownership.

Razbor can mention up to three configured individual accounts in its durable escalation comment. It checks ranked candidates against the provider until three accounts are verified. If none resolve, it tries a configured fallback. The bot updates its original comment with the reviewed commit and reasons. Repeated observations of the same decision do not generate another mention. Once escalated under an enabled policy, the PR stays in the provider’s human-controlled workflow. Razbor withdraws any earlier vote, including on the same commit, and reports when the forge cannot confirm its withdrawal. Keep the PR in human review until that vote has been settled.

The global PR page counts open requests needing human review. Both PR lists prioritize human review, blocked work, pending verification, active reviews and eligible changes. Their filters use the caller’s repository grants. The PR page uses the latest saved provider observations. The review page retains the historical assessment, threshold and policy version. A head, base, destination, draft, open-state or policy change invalidates a prior recommendation. Refresh the PR list to obtain newer provider metadata.

## Persistence and recovery

Phase 2 ends with `0032_gitlab_session_boundaries.sql`. Phase 3 adds policy and version snapshots in `0033_merge_policy.sql`, refines review invalidation in `0034`, and records native merge write stages in `0035`. Migration `0036` stores the approval operation separately on the review and defaults existing repositories to automatic approval off. Migration `0037` rechecks existing votes, native requests and GitHub dry-run decisions when upgrading. The migrator recognizes both previously published Phase 3 histories by SQL hash and applies their missing GitLab boundary migration under the migration lock. Reviews reference their PR and retain immutable policy and PR revision snapshots. PostgreSQL keeps review decisions, native write state, decision transitions, confirmed escalation comment revisions and the next reconciliation deadline. The dispatcher shares the publication lock with triage and commits a write intent before contacting a forge.

A timeout after a mutation leaves the action unconfirmed. Razbor reads back the exact reviewed operation and owned comment before proceeding. It never treats an empty response as proof that a merge failed. An unresolved write can require an operator to inspect the provider. Policy or source changes and repository deletion settle previous bot approvals before they commit. If an old vote cannot be withdrawn, use the [approval recovery procedure](merge-providers.md#optional-approval). If a policy save or replacement review reports a pending native request, settle that request in the provider and retry. Retry ordinary provider read failures by restoring credentials or connectivity; the dispatcher resumes from PostgreSQL. Inspect the decision’s reason on the PR or review page. When ordinary triage cannot read the provider or update the comment because permission was denied, it retries after one hour. A provider-specified retry time takes precedence, with a minimum delay of 30 seconds. This applies in live mode, dry run and comment reconciliation after merge. Outstanding native merge writes retain their recovery deadlines.

A registry edit to a repository’s Git configuration or selector must settle outstanding merge requests using the existing verified binding. If the provider cannot confirm their outcome, the import keeps the previous source and verification. After a successful source change, verify the repository and request a new review before relying on automatic merging, even when the commit is unchanged.

To rotate a revoked registry credential while a policy or source edit is blocked, first import a TOML file with the existing registry key, the updated forge definition, and an empty `[repositories]` table. Run `pnpm manage config apply <credential-file>`, then apply the full registry. The first import commits only the credential change. The second can authenticate the provider and settle the outstanding request before saving the repository edits.

For new escalations, Razbor reserves a comment without mentioning anyone, saves its provider ID, and edits that comment to deliver the decision. After a lost creation response, it checks the complete comment list and can retry the reservation after two minutes. A delayed reservation can never notify a reviewer. Reconciliation removes unused reservations and continues checking for outstanding ones hourly after closure.

Each edit carries a unique hidden receipt. Razbor records the hash of the complete outgoing comment and its mention attempt before sending the edit. A definitive rejection restores the mention for a retry. After a timeout, Razbor can update the decision without repeating the mention. When it reads the exact edit back on the same bot-owned comment, it clears that receipt. If a late edit restored an older decision, Razbor corrects the comment. A settled PR stops its hourly edit checks once every outstanding receipt has been accounted for.

Two edits can finish between reads. The provider may then display only the later edit, leaving the earlier receipt pending. To settle an individual receipt, drain all dispatchers and identify the repository, PR, bot and comment at the provider. Decode the JSON comment body field and compute SHA-256 over its exact UTF-8 text, preserving the hidden edit ID, whitespace and newlines. Match that digest to the saved receipt. Verify the edit took effect or that the provider definitively rejected the exact request and it can no longer arrive. Record the outcome and evidence in the incident.

On GitHub.com, an administrator can inspect **Recent deliveries** for a repository or GitHub App webhook subscribed to `issue_comment`. A GitHub-issued `edited` delivery confirms one applied edit when the repository ID, PR number, comment ID, comment author and editing sender match the expected repository and bot, and the decoded `comment.body` matches the receipt. Use the saved delivery GUID in the incident record. GitHub's `issue_comment.update` audit event omits the comment text and cannot identify the receipt. If there is no matching delivery or other definitive provider evidence, leave the receipt pending. [GitHub webhook deliveries](https://docs.github.com/en/webhooks/testing-and-troubleshooting-webhooks/viewing-webhook-deliveries) · [Edited comment payload](https://github.com/octokit/webhooks/blob/main/payload-examples/api.github.com/issue_comment/edited.payload.json) · [GitHub audit event fields](https://docs.github.com/en/enterprise-cloud@latest/admin/monitoring-activity-in-your-enterprise/reviewing-audit-logs-for-your-enterprise/audit-log-events-for-your-enterprise#issue_commentupdate).

In a database maintenance transaction, bind `$1` to the PR public ID, `$2` to the bot ID, `$3` to the remote comment ID and `$4` to the verified lowercase hex digest. Run this once per verified receipt. Commit only if the update returns the expected PR and remaining receipts. Roll back on a mismatch. Resume the dispatcher so it can restore the current decision.

```sql
UPDATE pull_requests
SET escalation_comment = CASE
      WHEN jsonb_array_length(escalation_comment->'uncertainEdit') = 1
        THEN escalation_comment - 'uncertainEdit'
      ELSE jsonb_set(escalation_comment, '{uncertainEdit}',
                     (escalation_comment->'uncertainEdit') - $4::text)
    END,
    merge_after = now()
WHERE public_id = $1 AND escalation_comment->>'botId' = $2
  AND escalation_comment->>'remoteId' = $3
  AND jsonb_typeof(escalation_comment->'uncertainEdit') = 'array'
  AND $4::text ~ '^[0-9a-f]{64}$'
  AND (escalation_comment->'uncertainEdit') ? $4::text
RETURNING public_id, escalation_comment->'uncertainEdit' AS remaining_receipts;
```

Older installations recorded ambiguous edits without receipts. Razbor uses the same recovery if more than 32 edits to one comment are simultaneously unconfirmed. For a boolean `uncertainEdit`, drain the dispatchers, verify in the provider request records that **all** prior edits to that comment ID have settled, and check the note against the saved `shownBody`. A database operator can then remove that flag for the verified PR, bot and comment, set `merge_after = now()`, and resume the dispatcher. On GitHub.com, keep the flag when the available records cannot account for every outstanding write. Confirmed deletion also retires outstanding edits for that comment ID.

While human review is required, Razbor periodically checks that its note still exists. Recreating a confirmed deleted note preserves its notification history. Older installations that already sent a direct notification retain the original write fence until an exact bot-owned note is found or the operator confirms a definitive provider rejection from its request logs.

For a legacy notification, the PR detail shows **unconfirmed delivery** after two minutes. If the provider confirms the original POST was rejected, pause the dispatcher and use an administrative database connection to clear that one legacy intent. Bind `$1` to the PR public ID, `$2` to the original bot ID, and `$3` to the exact saved creation body. Verify that the update returns the expected PR before resuming the dispatcher. A timeout or a missing comment in the list is insufficient evidence of rejection.

```sql
UPDATE pull_requests
SET escalation_comment = jsonb_build_object('botId', $2::text, 'mentioned', true),
    merge_after = now()
WHERE public_id = $1
  AND escalation_comment->>'botId' = $2
  AND escalation_comment->>'creatingBody' = $3
  AND escalation_comment->>'remoteId' IS NULL
RETURNING public_id;
```

This recovery preserves the one-mention limit. If the provider confirmed that no notification reached the reviewers, notify them manually after resuming the dispatcher.

The supported configuration differs by provider. See [provider protection, permissions and limitations](merge-providers.md).
