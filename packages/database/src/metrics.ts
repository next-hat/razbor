import { publicIdSchema, type ReviewMetrics } from "@razbor/contracts";

import type { Database } from "@database/src/connection.js";

/**
 * Build a SQL fingerprint using the same root-cause fields and normalization
 * as published finding markers; line-number changes do not create separate identities.
 * The expression is supplied only by the static query below, never by callers.
 */
function findingFingerprint(expression: string) {
  return `jsonb_build_array(
    ${expression}->>'path',
    trim(regexp_replace(lower(${expression}->>'body'), '[^a-z0-9]+', ' ', 'g')),
    trim(regexp_replace(lower(${expression}->>'failureScenario'), '[^a-z0-9]+', ' ', 'g')),
    trim(regexp_replace(lower(${expression}->>'suggestion'), '[^a-z0-9]+', ' ', 'g'))
  )`;
}

// Keep result documents and finding comparisons inside PostgreSQL. Only the
// aggregate snapshot leaves the database, irrespective of retained history.
const metricsQuery = `
with raw_reviews as materialized (
  select r.*, p.public_id as repository_public_id,
    coalesce(nullif(p.observed->>'fullPath', ''), p.config_key) as repository_name,
    coalesce(t.change, r.source->'pullRequest') as change,
    coalesce(nullif(t.change->>'headBranch', ''), nullif(r.source->>'headBranch', '')) as head_branch,
    coalesce(nullif(t.change->>'baseBranch', ''), nullif(r.source->>'baseBranch', '')) as base_branch,
    coalesce(r.finished_at, r.created_at) as reported_at,
    (coalesce(r.source->'conversation' <> 'null'::jsonb, false)
      or coalesce(r.result->>'mode' = 'conversation', false)) as conversational
  from reviews r
  join repositories p on p.id = r.repository_id
  left join review_triggers t on t.review_id = r.id
  where ($3::text is null or p.public_id = $3)
    and ($5::text[] is null or p.public_id = any($5::text[]))
    and r.created_at <= $2::timestamptz
), keyed_reviews as (
  select r.*,
    case when nullif(change->>'number', '') is not null then 'change:' || (change->>'number')
      when head_branch is not null then 'branch:' || head_branch
      else 'revision:' || base_sha || ':' || head_sha end as primary_key,
    case when nullif(change->>'number', '') is not null then 'change'
      when head_branch is not null then 'branch' else 'revision' end as primary_kind,
    case when nullif(change->>'number', '') is not null then 'change:' || (change->>'number')
      when head_branch is not null then 'branch:' || head_branch end as lineage_key
  from raw_reviews r
), review_context as materialized (
  select r.*,
    jsonb_strip_nulls(jsonb_build_object(
      'key', primary_key, 'kind', primary_kind,
      'label', case primary_kind
        when 'change' then concat('#', change->>'number', ' ', change->>'title')
        when 'branch' then head_branch
        else concat(left(base_sha, 7), '…', left(head_sha, 7)) end,
      'number', case when primary_kind = 'change' then change->'number' end,
      'url', case when primary_kind = 'change' then change->>'url' end,
      'headBranch', head_branch, 'baseBranch', base_branch
    )) as primary_target,
    jsonb_strip_nulls(jsonb_build_object(
      'key', 'branch:' || head_branch, 'kind', 'branch', 'label', head_branch,
      'headBranch', head_branch, 'baseBranch', base_branch
    )) as branch_target
  from keyed_reviews r
), filtered_reviews as (
  select * from review_context
  where $4::text is null or primary_key = $4 or 'branch:' || head_branch = $4
), dimensions as materialized (
  select r.id, d.scope_type, d.scope_repository_id, d.scope_target_key, d.target,
    r.repository_name, r.created_at
  from filtered_reviews r
  cross join lateral (
    values ('overall', null::text, null::text, null::jsonb),
      ('repository', r.repository_public_id, null::text, null::jsonb),
      ('target', r.repository_public_id, r.primary_key, r.primary_target)
    union all
    select 'target', r.repository_public_id, 'branch:' || r.head_branch, r.branch_target
    where r.head_branch is not null and r.primary_kind <> 'branch'
  ) d(scope_type, scope_repository_id, scope_target_key, target)
), selected_reviews as materialized (
  select r.*, a.metrics,
    (jsonb_typeof(a.metrics->'addedLines') = 'number'
      and jsonb_typeof(a.metrics->'deletedLines') = 'number') as diff_measured
  from filtered_reviews r
  left join review_attempts a on a.review_id = r.id and a.version = r.version
    and a.status = 'completed'
  where ($1::timestamptz is null or r.reported_at >= $1)
    and r.reported_at <= $2::timestamptz
), review_rollup as (
  select d.scope_type, d.scope_repository_id, d.scope_target_key,
    count(*) filter (where not r.conversational and r.status = 'completed') as completed_reviews,
    count(*) filter (where not r.conversational and r.status = 'failed') as failed_reviews,
    count(*) filter (where not r.conversational and r.status = 'queued') as queued_reviews,
    count(*) filter (where not r.conversational and r.status = 'running') as running_reviews,
    count(*) filter (where r.conversational and r.status = 'completed') as conversation_replies,
    coalesce(sum((r.metrics->>'addedLines')::numeric) filter
      (where not r.conversational and r.status = 'completed' and r.diff_measured), 0) as added_lines,
    coalesce(sum((r.metrics->>'deletedLines')::numeric) filter
      (where not r.conversational and r.status = 'completed' and r.diff_measured), 0) as deleted_lines,
    coalesce(sum((r.metrics->>'changedFiles')::numeric) filter
      (where not r.conversational and r.status = 'completed' and r.diff_measured), 0) as changed_files,
    count(*) filter (where not r.conversational and r.status = 'completed' and r.diff_measured) as diff_measured_reviews,
    coalesce(sum(jsonb_array_length(r.result->'findings')) filter
      (where not r.conversational and r.status = 'completed'), 0) as findings,
    avg(extract(epoch from (r.finished_at - r.started_at)) * 1000) filter
      (where not r.conversational and r.status = 'completed'
        and r.started_at is not null and r.finished_at >= r.started_at) as average_duration_ms,
    count(*) filter (where not r.conversational and r.status = 'completed'
      and r.started_at is not null and r.finished_at >= r.started_at) as duration_measured_reviews
  from dimensions d join selected_reviews r on r.id = d.id
  group by d.scope_type, d.scope_repository_id, d.scope_target_key
), distinct_diffs as (
  select distinct on (d.scope_type, d.scope_repository_id, d.scope_target_key,
    r.repository_id, r.base_sha, r.head_sha)
    d.scope_type, d.scope_repository_id, d.scope_target_key, r.metrics
  from dimensions d join selected_reviews r on r.id = d.id
  where not r.conversational and r.status = 'completed' and r.diff_measured
  order by d.scope_type, d.scope_repository_id, d.scope_target_key,
    r.repository_id, r.base_sha, r.head_sha, r.created_at desc, r.id desc
), distinct_diff_rollup as (
  select scope_type, scope_repository_id, scope_target_key,
    sum((metrics->>'addedLines')::numeric) as distinct_added_lines,
    sum((metrics->>'deletedLines')::numeric) as distinct_deleted_lines,
    count(*) as distinct_diffs
  from distinct_diffs group by scope_type, scope_repository_id, scope_target_key
), usage_rollup as (
  select d.scope_type, d.scope_repository_id, d.scope_target_key,
    count(*) as attempts,
    count(*) filter (where jsonb_typeof(a.metrics->'inputTokens') = 'number'
      or jsonb_typeof(a.metrics->'outputTokens') = 'number') as usage_recorded_attempts,
    count(*) filter (where a.metrics->>'finalized' = 'true'
      and a.status in ('completed', 'failed') and a.metrics->>'tokenUsageComplete' = 'true'
      and jsonb_typeof(a.metrics->'inputTokens') = 'number'
      and jsonb_typeof(a.metrics->'outputTokens') = 'number') as complete_usage_attempts,
    count(*) filter (where jsonb_typeof(a.metrics->'cachedInputTokens') = 'number') as cached_usage_recorded_attempts,
    coalesce(sum((a.metrics->>'inputTokens')::numeric), 0) as input_tokens,
    coalesce(sum((a.metrics->>'outputTokens')::numeric), 0) as output_tokens,
    coalesce(sum((a.metrics->>'cachedInputTokens')::numeric), 0) as cached_input_tokens
  from dimensions d join review_attempts a on a.review_id = d.id
  where ($1::timestamptz is null or a.created_at >= $1)
    and a.created_at <= $2::timestamptz
  group by d.scope_type, d.scope_repository_id, d.scope_target_key
), completed_history as materialized (
  select * from review_context
  where status = 'completed' and not conversational and reported_at <= $2::timestamptz
), historical_findings as materialized (
  select distinct r.id, r.repository_id, r.lineage_key, r.created_at,
    ${findingFingerprint("finding.value")} as fingerprint
  from completed_history r
  cross join lateral jsonb_array_elements(coalesce(r.result->'findings', '[]'::jsonb)) finding(value)
), latest_reported_findings as (
  select distinct on (repository_id, lineage_key, fingerprint) *
  from historical_findings where lineage_key is not null
  order by repository_id, lineage_key, fingerprint, created_at desc, id desc
), historical_assessments as materialized (
  select r.id, r.repository_id, r.lineage_key, r.created_at,
    prior.value->>'reviewId' as origin_public_id,
    ${findingFingerprint("prior.value->'finding'")} as fingerprint,
    coalesce(check_item.status, 'uncertain') as status
  from completed_history r
  cross join lateral jsonb_array_elements(coalesce(r.source->'previousFindings', '[]'::jsonb)) prior(value)
  left join lateral (
    select check_item.value->>'status' as status
    from jsonb_array_elements(coalesce(r.result->'findingChecks', '[]'::jsonb)) check_item(value)
    where check_item.value->>'id' = prior.value->>'id' limit 1
  ) check_item on true
), origin_findings as materialized (
  select distinct r.id, r.public_id, r.repository_id, r.lineage_key, r.created_at,
    ${findingFingerprint("finding.value")} as fingerprint
  from selected_reviews r
  cross join lateral jsonb_array_elements(coalesce(r.result->'findings', '[]'::jsonb)) finding(value)
  where r.status = 'completed' and not r.conversational
), explicit_assessments as (
  select f.id as origin_id, f.fingerprint, r.id as assessment_id, r.created_at,
    case when h.id is not null then 'open'
      else r.status end as status
  from origin_findings f
  join historical_assessments r on r.repository_id = f.repository_id and r.created_at > f.created_at
    and (f.lineage_key is null or r.lineage_key = f.lineage_key)
    and (r.origin_public_id = f.public_id or f.lineage_key is not null) and r.fingerprint = f.fingerprint
  left join historical_findings h on h.id = r.id and h.fingerprint = f.fingerprint
), assessments as (
  select * from explicit_assessments
  union all
  select f.id, f.fingerprint, h.id, h.created_at, 'open'
  from origin_findings f
  join latest_reported_findings h on h.repository_id = f.repository_id
    and h.lineage_key = f.lineage_key and h.created_at > f.created_at
    and h.fingerprint = f.fingerprint
), latest_assessments as (
  select distinct on (origin_id, fingerprint) origin_id, fingerprint, status, created_at, assessment_id
  from assessments
  order by origin_id, fingerprint, created_at desc, assessment_id desc,
    case status when 'open' then 0 when 'uncertain' then 1 else 2 end
), latest_lineage_reviews as (
  select distinct on (repository_id, lineage_key) id, repository_id, lineage_key, created_at
  from completed_history where lineage_key is not null
  order by repository_id, lineage_key, created_at desc, id desc
), latest_followups as (
  select f.id as origin_id, f.fingerprint,
    r.created_at, r.id as followup_id,
    h.id is not null as still_reported
  from origin_findings f
  join latest_lineage_reviews r on r.repository_id = f.repository_id
    and r.lineage_key = f.lineage_key and r.created_at > f.created_at
  left join historical_findings h on h.id = r.id and h.fingerprint = f.fingerprint
), outcome_rollup as (
  select d.scope_type, d.scope_repository_id, d.scope_target_key,
    count(*) filter (where a.status = 'resolved') as confirmed_resolved_findings,
    count(*) filter (where followup.still_reported = false
      and (coalesce(a.status, '') not in ('open', 'uncertain')
        or (a.created_at, a.assessment_id) < (followup.created_at, followup.followup_id))) as no_longer_reported_findings
  from origin_findings f join dimensions d on d.id = f.id
  left join latest_assessments a on a.origin_id = f.id and a.fingerprint = f.fingerprint
  left join latest_followups followup on followup.origin_id = f.id and followup.fingerprint = f.fingerprint
  group by d.scope_type, d.scope_repository_id, d.scope_target_key
), scope_keys as (
  select scope_type, scope_repository_id, scope_target_key from review_rollup
  union select scope_type, scope_repository_id, scope_target_key from usage_rollup
  union select 'overall', null::text, null::text
  union select 'repository', public_id, null::text from repositories
    where ($3::text is null or public_id = $3) and $4::text is null
      and ($5::text[] is null or public_id = any($5::text[]))
), scope_catalog as (
  select distinct on (scope_type, scope_repository_id, scope_target_key)
    scope_type, scope_repository_id, scope_target_key, repository_name, target
  from dimensions
  order by scope_type, scope_repository_id, scope_target_key, created_at desc, id desc
), scope_results as (
  select s.scope_type, s.scope_repository_id, s.scope_target_key,
    coalesce(c.repository_name, nullif(p.observed->>'fullPath', ''), p.config_key) as repository_name,
    c.target,
    jsonb_build_object(
      'completedReviews', coalesce(r.completed_reviews, 0),
      'failedReviews', coalesce(r.failed_reviews, 0),
      'queuedReviews', coalesce(r.queued_reviews, 0),
      'runningReviews', coalesce(r.running_reviews, 0),
      'conversationReplies', coalesce(r.conversation_replies, 0),
      'addedLines', coalesce(r.added_lines, 0),
      'deletedLines', coalesce(r.deleted_lines, 0),
      'distinctAddedLines', coalesce(diff.distinct_added_lines, 0),
      'distinctDeletedLines', coalesce(diff.distinct_deleted_lines, 0),
      'changedFiles', coalesce(r.changed_files, 0),
      'diffMeasuredReviews', coalesce(r.diff_measured_reviews, 0),
      'distinctDiffs', coalesce(diff.distinct_diffs, 0),
      'findings', coalesce(r.findings, 0),
      'confirmedResolvedFindings', coalesce(outcomes.confirmed_resolved_findings, 0),
      'noLongerReportedFindings', coalesce(outcomes.no_longer_reported_findings, 0),
      'inputTokens', coalesce(u.input_tokens, 0),
      'outputTokens', coalesce(u.output_tokens, 0),
      'cachedInputTokens', coalesce(u.cached_input_tokens, 0),
      'attempts', coalesce(u.attempts, 0),
      'usageRecordedAttempts', coalesce(u.usage_recorded_attempts, 0),
      'completeUsageAttempts', coalesce(u.complete_usage_attempts, 0),
      'cachedUsageRecordedAttempts', coalesce(u.cached_usage_recorded_attempts, 0),
      'averageDurationMs', r.average_duration_ms,
      'durationMeasuredReviews', coalesce(r.duration_measured_reviews, 0)
    ) as totals
  from scope_keys s
  left join repositories p on p.public_id = s.scope_repository_id
  left join scope_catalog c on c.scope_type = s.scope_type
    and c.scope_repository_id is not distinct from s.scope_repository_id
    and c.scope_target_key is not distinct from s.scope_target_key
  left join review_rollup r on r.scope_type = s.scope_type
    and r.scope_repository_id is not distinct from s.scope_repository_id
    and r.scope_target_key is not distinct from s.scope_target_key
  left join distinct_diff_rollup diff on diff.scope_type = s.scope_type
    and diff.scope_repository_id is not distinct from s.scope_repository_id
    and diff.scope_target_key is not distinct from s.scope_target_key
  left join usage_rollup u on u.scope_type = s.scope_type
    and u.scope_repository_id is not distinct from s.scope_repository_id
    and u.scope_target_key is not distinct from s.scope_target_key
  left join outcome_rollup outcomes on outcomes.scope_type = s.scope_type
    and outcomes.scope_repository_id is not distinct from s.scope_repository_id
    and outcomes.scope_target_key is not distinct from s.scope_target_key
), activity_counts as (
  select (reported_at at time zone 'UTC')::date as date, count(*) as completed_reviews
  from selected_reviews where status = 'completed' and not conversational
  group by (reported_at at time zone 'UTC')::date
), activity_days as (
  select ($2::timestamptz at time zone 'UTC')::date - day as date
  from generate_series(0, 364) day
)
select jsonb_build_object(
  'totals', (select totals from scope_results where scope_type = 'overall'),
  'repositories', coalesce((select jsonb_agg(jsonb_build_object(
    'repositoryId', scope_repository_id, 'repositoryName', repository_name, 'totals', totals
  ) order by repository_name, scope_repository_id) from scope_results where scope_type = 'repository'), '[]'::jsonb),
  'targets', coalesce((select jsonb_agg(jsonb_build_object(
    'repositoryId', scope_repository_id, 'repositoryName', repository_name, 'target', target, 'totals', totals
  ) order by repository_name, target->>'kind', target->>'label', scope_target_key)
    from scope_results where scope_type = 'target'), '[]'::jsonb),
  'activity', (select jsonb_agg(jsonb_build_object(
    'date', to_char(day.date, 'YYYY-MM-DD'), 'completedReviews', coalesce(activity.completed_reviews, 0)
  ) order by day.date) from activity_days day left join activity_counts activity on activity.date = day.date)
) as snapshot
`;

/**
 * Aggregate retained review history without the recent-review listing limit.
 * Review, diff and finding totals use completion time, or submission time for
 * unfinished jobs. Usage counts each attempt's cumulative snapshot once in its
 * start-date period, including failed attempts and conversational replies;
 * cached tokens are a subset of input tokens. Missing telemetry is represented
 * by coverage counts rather than invented measurements.
 *
 * Distinct diffs deduplicate exact repository/primary-target/base/head pairs;
 * branch rows deduplicate within that branch instead and overlap change rows.
 * Finding outcomes belong to origins completed in the selected period, using
 * the newest submitted completed assessment available at snapshot time. An
 * explicit open/uncertain assessment or reappearance supersedes resolution.
 * Absence is assessed only within the same change, or branch without change
 * identity, and never confirms a fix. A current open/uncertain/missing recheck
 * blocks absence; an older assessment does not block a newer absent report.
 * Resolved and absent counts can overlap.
 *
 * The activity calendar always contains the last 365 UTC days, with zeroes
 * outside the selected period. A missing day limit selects all retained history.
 * Repository grants apply to history and the zero-review catalog; an empty
 * grant list yields zero overall totals and no repository or target rows.
 */
export async function getReviewMetrics(
  database: Database,
  options: {
    days?: 30 | 90 | 365;
    repositoryId?: string;
    repositoryIds?: string[];
    targetKey?: string;
  } = {},
): Promise<ReviewMetrics> {
  if (options.repositoryId)
    publicIdSchema("repository").parse(options.repositoryId);
  options.repositoryIds?.forEach((id) =>
    publicIdSchema("repository").parse(id),
  );
  if (options.days !== undefined && ![30, 90, 365].includes(options.days))
    throw new Error("Invalid metrics reporting period");
  if (
    options.targetKey !== undefined &&
    (typeof options.targetKey !== "string" ||
      !options.repositoryId ||
      options.targetKey.length > 2048 ||
      !/^(?:change|branch|revision):.+$/.test(options.targetKey))
  )
    throw new Error("Invalid metrics target");
  const asOf = new Date();
  const from = options.days
    ? new Date(
        Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), asOf.getUTCDate()) -
          (options.days - 1) * 86400000,
      ).toISOString()
    : null;
  const to = asOf.toISOString();
  const result = await database.pool.query<{
    snapshot: Omit<ReviewMetrics, "asOf" | "range">;
  }>(metricsQuery, [
    from,
    to,
    options.repositoryId ?? null,
    options.targetKey ?? null,
    options.repositoryIds ?? null,
  ]);
  return { asOf: to, range: { from, to }, ...result.rows[0].snapshot };
}
