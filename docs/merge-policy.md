# Merge policy and human review

Open **Repository → Settings → Merge Policy** with repository management access. Choose the confidence threshold, merge method and candidate reviewers, write the Markdown policy, and save. File-managed repositories display their settings read-only. Review triggering remains a separate setting. A console request, an authorized comment command and an automatic code review all use the repository policy captured at admission. Conversational replies cannot authorize a merge.

Automation starts disabled. Enable it with **Dry run** selected to evaluate real provider requirements and publish human escalations while making zero merge mutations. An eligible result appears as **Dry run · would schedule**. Configure and verify provider protection before turning dry run off. Every policy change creates a new version, including switching out of dry run. Request a fresh review before expecting the new version to authorize a merge.

## Settings

| Setting                | Default | Effect                                                                                                                                     |
| ---------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `enabled`              | false   | Permits escalation comments and guarded automatic merging. The console can still present review assessments while disabled.                |
| `dryRun`               | true    | Records eligibility without scheduling a merge or releasing a provider check.                                                              |
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

## How a decision is made

The model receives the saved policy and allowlist in both indexed and source-only reviews. Confidence is an **uncalibrated model assessment of merge readiness**. A score of 95 is not a 95% probability of correctness. Repository managers can inspect the detailed assessment evidence, commands and verification gaps on the review. Members see the score, risk and service-generated decision reasons. Forge escalation comments use service-generated reasons and the verified reviewer names. A complete, low-risk review still needs a matching policy version and revisions, no actionable or outstanding findings, and provider permission to merge. New code reviews include a structured assessment. Historical results without one cannot authorize merging.

The server reconciles published findings, including open and uncertain findings from earlier runs, before checking the forge. High or critical risk, affected critical areas, incomplete investigation, and an explicit request for human review all require a human. Markdown can explain project criticality. The server owns authorization and enforces the saved structured policy and provider protections.

Razbor can mention up to three configured individual accounts in its durable escalation comment. It checks ranked candidates against the provider until three accounts are verified. If none resolve, it tries a configured fallback. The bot updates its original comment with the reviewed commit and reasons. Repeated observations of the same decision do not generate another mention. Once escalated under an enabled policy, the PR stays in the provider’s human-controlled workflow. A later high score or a comment claiming approval cannot release it.

The global PR page counts open requests needing human review. Both PR lists prioritize human review, blocked work, pending verification, active reviews and eligible changes. Their filters use the caller’s repository grants. The PR page uses the latest saved provider observations. The review page retains the historical assessment, threshold and policy version. A head, base, destination, draft, open-state or policy change invalidates a prior recommendation. Refresh the PR list to obtain newer provider metadata.

## Persistence and recovery

Migration `0032_merge_policy.sql` adds the repository policy and its version after the Phase 2 deferred-delivery migration (`0031`). Migration `0033` refines when provider observations invalidate a review, and `0034` records the stage of each native merge write for recovery. Reviews reference their PR and retain immutable policy and PR revision snapshots. PostgreSQL keeps review decisions, native write state, decision transitions, confirmed escalation comment revisions and the next reconciliation deadline. The dispatcher shares the publication lock with triage and commits a write intent before contacting a forge.

A timeout after a mutation leaves the action unconfirmed. Razbor reads back the exact reviewed operation and owned comment before proceeding. It never treats an empty response as proof that a merge failed. An unresolved write can require an operator to inspect the provider. If a policy save or replacement review reports a pending native request, settle that request in the provider and retry. Retry ordinary provider read failures by restoring credentials or connectivity; the dispatcher resumes from PostgreSQL. Inspect the decision’s reason on the PR or review page.

To rotate a revoked registry credential while a policy edit is blocked, first import a TOML file with the existing registry key, the updated forge definition, and an empty `[repositories]` table. Run `pnpm manage config apply <credential-file>`, then apply the full registry. The first import commits only the credential change. The second can authenticate the provider and settle the outstanding request before saving the new policy.

For new escalations, Razbor reserves a comment without mentioning anyone, saves its provider ID, and edits that comment to deliver the decision. After a lost creation response, it checks the complete comment list and can retry the reservation after two minutes. A delayed reservation can never notify a reviewer. Reconciliation removes unused reservations and continues checking for outstanding ones hourly after closure. Razbor records its mention attempt before editing the confirmed note. A definitive rejection restores the first mention for a retry. After an ambiguous edit, retries restore the text without repeating the mention. Razbor checks the same note hourly even after closure, so an older edit arriving late can be corrected. Once the provider confirms the note was deleted, writes to its old ID can no longer overwrite a replacement. To retire the hourly check on an existing note, drain the dispatcher, confirm in the provider request history that all prior edits to that ID have completed, and verify that the note matches the saved `shownBody`. A database operator can then remove only the `uncertainEdit` key from that PR’s `escalation_comment` and set `merge_after = now()` before restarting the dispatcher. While human review is required, Razbor periodically checks that its note still exists. Recreating a confirmed deleted note preserves its notification history. Older installations that already sent a direct notification retain the original write fence until an exact bot-owned note is found or the operator confirms a definitive provider rejection from its request logs.

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

The supported configuration differs by provider. See [provider protection, permissions and limitations](merge-providers.md).
