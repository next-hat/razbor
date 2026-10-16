# Understand review metrics

**Overview** shows review activity, findings, changed lines, and observed model
usage for repositories you can access. Filter by period, repository, or pull
request/branch. Open **Repositories** for individual reviews.

Totals come from retained PostgreSQL history, including reviews outside the
recent-review list. Expiring execution logs preserves these measurements;
deleting a repository removes its history and metrics.

## What the numbers mean

| Metric                    | Meaning                                                                                                                                         |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Completed reviews         | Completed code reviews, including repeats. Finding-thread replies are counted separately.                                                       |
| Cumulative diff           | Added and deleted text lines across completed reviews. Reviewing the same commits twice counts their lines twice.                               |
| Distinct revisions        | Added and deleted lines, counting each exact base/head pair once in the selected scope. Different pairs can contain overlapping changes.        |
| Findings reported         | Finding occurrences in completed reviews. Repeated reports can count more than once.                                                            |
| Confirmed resolved        | Earlier findings explicitly assessed as resolved by a later review. A newer open/uncertain assessment or reappearance replaces that outcome.    |
| No longer reported        | Earlier findings absent from the latest comparable review, without a current open/uncertain assessment. Absence alone does not establish a fix. |
| Observed tokens           | Provider-reported input + output tokens, including failed attempts, retries, active runs, and conversation replies.                             |
| Cached input              | The cached portion of input tokens, already included in input.                                                                                  |
| Average review duration   | Average time from a successful run's start to completion, where both timestamps are available.                                                  |
| Review failure rate       | Failed reviews divided by completed + failed reviews. Excludes queued/running reviews and conversations.                                        |
| Confirmed resolution rate | Confirmed resolved finding occurrences divided by reported finding occurrences in the selected period.                                          |

Reviewing a 100-line diff three times contributes 300 cumulative lines and 100
distinct-revision lines. Neither count establishes that the model read every line
or proved the code correct. Binary changes have no text line count.

**Confirmed resolved** is the reviewer's assessment, not proof of a merged fix.
It can overlap **No longer reported**, so do not add those counts. Branch and pull
request breakdowns can also overlap.

Review and finding counts use the completion date, or submission date for
unfinished work. Findings in the selected period use their latest known
assessment. Tokens belong to the day an attempt started, even if it crosses
midnight.

## Why some measurements are incomplete

Older reviews may lack token or diff measurements. Some providers omit usage,
and failed or interrupted requests can leave gaps. Coverage indicators distinguish
measured zeroes from missing data.

With incomplete coverage, observed usage is a lower bound. Running attempts are
provisional. Token totals are not a bill; check pricing and charges with your
model provider.

## Mark evaluation samples and findings

1. Open a completed code review.
2. Select **Include this review in evaluation** to mark it as a sample.
3. Expand a finding's **View more** section and choose:
   - **Confirmed finding:** you checked the issue and consider it actionable,
     whether or not it is fixed.
   - **Potential false positive:** you suspect an error and want to investigate.
   - **Unassessed:** leave no judgment, or clear an earlier one.

Wait for **Evaluation saved**. Marks belong to that review and its commits. A
later review starts unselected and unassessed. You can judge findings without
selecting the review as a sample.

Judgments are separate from resolution status. Confirming a finding does not mean
it is fixed. Marks do not alter results, published comments, thread state, or
re-review assessments, and the model does not receive them. Selecting samples
does not run an evaluation or calculate accuracy.

For comparisons pinned to known revisions, defects, and negative controls, use
the [offline evaluation workflow](review-evaluation.md). It tracks missed issues,
false positives, unsafe suggestions, and unsuccessful runs separately from
console marks.

## Compare reviewer or search settings

Try settings on a small, representative set of real pull requests before applying
them across repositories. Include known bugs, changes believed to be clean, and
past false positives. Keep this set separate from examples used to tune settings.

1. Save exact base/head commits and independently verify known issues. Exclude
   later fixes and review answers from the model's context.
2. Change one setting at a time. Hold the model, prompts, repository context,
   tool limits, and budgets constant unless they are the subject of the comparison.
3. Mix the order of repeated runs. Have a person check each distinct finding
   against the saved source, ideally without knowing which setting produced it.
4. Compare actionable findings, invalid findings, missed known issues, tokens,
   duration, and failures. Keep uncertain findings separate. A newly discovered
   issue is not a false positive just because it was absent from your original list.

For [semantic search](indexing.md), compare index mode and the embedding tool
separately:

| Comparison                                     | What it measures                       |
| ---------------------------------------------- | -------------------------------------- |
| CBM `fast` → CBM `full`                        | The index-mode change.                 |
| CBM `full` → CBM `full` plus razbor embeddings | The additional `semantic_search` tool. |

Confirm each index is ready for the intended commit and record indexer and
embedding model versions. Better search matches or more findings alone do not
establish better reviews. Report variation across runs and limit conclusions
drawn from a small sample.
