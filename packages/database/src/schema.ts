import { sql } from "drizzle-orm";
import type { z } from "zod";
import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  integer,
  boolean,
  uniqueIndex,
  check,
  index,
  primaryKey,
  customType,
  foreignKey,
  unique,
} from "drizzle-orm/pg-core";

import {
  publicIdPattern,
  type ModelProvider,
  type ReasoningEffort,
  type ResourceKind,
  type ReviewResult,
  type ReviewEvaluation,
  type PreviousFinding,
  type ReviewConversation,
  type ReviewAgentSnapshot,
  type ReviewAttemptMetrics,
  type ReviewLog,
  type RepositoryGuidance,
  type ReviewGuidanceSnapshot,
  type McpServerSnapshot,
  type GithubInstallation,
} from "@razbor/contracts";
import type { repositoryConfigSchema } from "@razbor/harness/git-policy";
import type {
  RepositoryMetadata,
  ForgeType,
  ForgeChange,
  ForgePublicationProgress,
  InlineComment,
} from "@razbor/forge-adapters";

export type GitPolicy = z.infer<typeof repositoryConfigSchema>;

export type SecretReference =
  | { env: string }
  | { file: string }
  | { stored: string }
  | { github_app: GithubInstallation }
  | { githubApp: string };

/** Create internal UUID and unique public ID columns for a resource table. */
const identity = () => ({
  id: uuid("id").primaryKey().defaultRandom(),
  publicId: text("public_id").notNull().unique(),
});

/**
 * Create database-initialized audit timestamps; updates remain the caller's
 * responsibility.
 */
const times = () => ({
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/** Constrain a resource's public ID to the same format accepted by the API. */
const format = (name: string, column: unknown, kind: ResourceKind) => {
  const pattern = sql.raw(`'${publicIdPattern(kind)}'`);
  return check(`${name}_public_id_format`, sql`${column} ~ ${pattern}`);
};

export const accountContexts = pgTable(
  "account_contexts",
  {
    ...identity(),
    ...times(),
    name: text("name").notNull(),
    kind: text("kind").$type<"personal" | "organization">().notNull(),
    userId: uuid("user_id").references(() => consoleUsers.id, {
      onDelete: "cascade",
    }),
  },
  (t) => [
    format("account_context", t.publicId, "context"),
    uniqueIndex("account_contexts_personal_user_unique").on(t.userId),
    check(
      "account_context_kind",
      sql`${t.kind} in ('personal','organization')`,
    ),
    check(
      "account_context_owner",
      sql`(${t.kind} = 'personal') = (${t.userId} is not null)`,
    ),
    check("account_context_name", sql`length(${t.name}) between 1 and 100`),
  ],
);

export const agents = pgTable(
  "agents",
  {
    ...identity(),
    ...times(),
    contextId: uuid("context_id").references(() => accountContexts.id),
    provider: text("provider")
      .$type<ModelProvider>()
      .notNull()
      .default("openai"),
    endpoint: text("endpoint").notNull(),
    model: text("model").notNull(),
    reasoningEffort: text("reasoning_effort")
      .$type<ReasoningEffort>()
      .notNull()
      .default("high"),
    apiKey: text("api_key").notNull(),
  },
  (t) => [
    format("agent", t.publicId, "agent"),
    check("agent_provider", sql`${t.provider} in ('openai','anthropic')`),
    check(
      "agent_reasoning_effort",
      sql`${t.reasoningEffort} in ('low','medium','high')`,
    ),
    unique("agents_endpoint_model_unique")
      .on(t.contextId, t.endpoint, t.model)
      .nullsNotDistinct(),
  ],
);

export const skills = pgTable(
  "skills",
  {
    ...identity(),
    ...times(),
    contextId: uuid("context_id").references(() => accountContexts.id),
    name: text("name").notNull(),
    description: text("description").notNull(),
    version: integer("version").notNull().default(1),
    files: jsonb("files").$type<Record<string, string>>().notNull(),
    defaultReviewGuide: boolean("default_review_guide")
      .notNull()
      .default(false),
  },
  (t) => [
    format("skill", t.publicId, "skill"),
    unique("skills_name_unique").on(t.contextId, t.name).nullsNotDistinct(),
    uniqueIndex("skills_default_review_guide_unique")
      .on(t.contextId)
      .where(sql`${t.defaultReviewGuide}`),
    check("skill_version", sql`${t.version} > 0`),
    check("skill_files_object", sql`jsonb_typeof(${t.files}) = 'object'`),
    check(
      "skill_name",
      sql`length(${t.name}) between 1 and 64 and ${t.name} ~ '^[a-z0-9]+(-[a-z0-9]+)*$'`,
    ),
    check(
      "skill_description",
      sql`length(${t.description}) between 1 and 1000`,
    ),
  ],
);

export const mcpServers = pgTable(
  "mcp_servers",
  {
    ...identity(),
    ...times(),
    contextId: uuid("context_id").references(() => accountContexts.id),
    name: text("name").notNull(),
    endpoint: text("endpoint").notNull(),
    token: text("token").notNull().default(""),
    enabled: boolean("enabled").notNull().default(true),
  },
  (t) => [
    format("mcp_server", t.publicId, "mcpServer"),
    unique("mcp_servers_name_unique")
      .on(t.contextId, t.name)
      .nullsNotDistinct(),
    check(
      "mcp_server_name",
      sql`length(${t.name}) between 1 and 32 and ${t.name} ~ '^[a-z0-9]+(-[a-z0-9]+)*$'`,
    ),
    check("mcp_server_endpoint", sql`length(${t.endpoint}) between 1 and 2048`),
    check(
      "mcp_server_token",
      sql`length(${t.token}) <= 8192 and ${t.token} !~ '[[:cntrl:]]'`,
    ),
  ],
);

export const githubApps = pgTable(
  "github_apps",
  {
    ...identity(),
    ...times(),
    contextId: uuid("context_id").references(() => accountContexts.id),
    externalId: text("external_id").notNull(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    apiUrl: text("api_url").notNull(),
    webUrl: text("web_url").notNull(),
    appUrl: text("app_url").notNull(),
    callbackBase: text("callback_base").notNull(),
    privateKey: text("private_key").notNull(),
    webhookSecret: text("webhook_secret").notNull(),
    bot: jsonb("bot").$type<{ id: string; login: string }>(),
  },
  (t) => [
    format("github_app", t.publicId, "githubApp"),
    unique("github_apps_external_identity")
      .on(t.contextId, t.apiUrl, t.externalId)
      .nullsNotDistinct(),
  ],
);

export const forgeInstances = pgTable(
  "forge_instances",
  {
    ...identity(),
    ...times(),
    contextId: uuid("context_id").references(() => accountContexts.id),
    configKey: text("config_key").notNull(),
    managedBy: text("managed_by").notNull(),
    type: text("type").$type<ForgeType>().notNull(),
    apiUrl: text("api_url").notNull(),
    webUrl: text("web_url").notNull(),
    allowHttp: boolean("allow_http").notNull().default(false),
    credential: jsonb("credential").$type<SecretReference>(),
  },
  (t) => [
    format("forge", t.publicId, "forge"),
    unique("forge_instances_config_key_unique")
      .on(t.contextId, t.configKey)
      .nullsNotDistinct(),
    check("forge_type", sql`${t.type} in ('github','gitlab','forgejo')`),
  ],
);

export const repositories = pgTable(
  "repositories",
  {
    ...identity(),
    ...times(),
    contextId: uuid("context_id").references(() => accountContexts.id),
    configKey: text("config_key").notNull(),
    managedBy: text("managed_by").notNull(),
    forgeId: uuid("forge_id").references(() => forgeInstances.id),
    agentId: uuid("agent_id").references(() => agents.id, {
      onDelete: "restrict",
    }),
    // Null preserves existing runner capability settings until the UI saves guidance.
    guidance: jsonb("guidance").$type<RepositoryGuidance>(),
    selector: text("selector"),
    externalRepositoryId: text("external_repository_id"),
    observed: jsonb("observed").$type<RepositoryMetadata>(),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    git: jsonb("git").$type<GitPolicy>().notNull(),
    apiCredential: jsonb("api_credential").$type<SecretReference>(),
    status: text("status")
      .$type<"active" | "deleting">()
      .notNull()
      .default("active"),
    setupState: text("setup_state")
      .$type<"pending" | "indexing" | "ready" | "error">()
      .notNull()
      .default("ready"),
    setupError: text("setup_error"),
    indexOwner: text("index_owner").notNull(),
    persistent: boolean("persistent").notNull(),
    version: integer("version").notNull().default(1),
  },
  (t) => [
    format("repository", t.publicId, "repository"),
    unique("repositories_config_key_unique")
      .on(t.contextId, t.configKey)
      .nullsNotDistinct(),
    check("repository_status", sql`${t.status} in ('active','deleting')`),
    check(
      "repository_guidance_object",
      sql`${t.guidance} is null or jsonb_typeof(${t.guidance}) = 'object'`,
    ),
    check(
      "repository_setup_state",
      sql`${t.setupState} in ('pending','indexing','ready','error')`,
    ),
    uniqueIndex("repository_external_identity").on(
      t.contextId,
      t.forgeId,
      t.externalRepositoryId,
    ),
    uniqueIndex("repository_pending_external_identity")
      .on(t.forgeId, t.externalRepositoryId)
      .where(
        sql`${t.contextId} is null and ${t.forgeId} is not null and ${t.externalRepositoryId} is not null`,
      ),
  ],
);

export const pullRequests = pgTable(
  "pull_requests",
  {
    ...identity(),
    ...times(),
    repositoryId: uuid("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    number: integer("number").notNull(),
    title: text("title").notNull(),
    url: text("url").notNull(),
    state: text("state").$type<"open" | "closed">().notNull(),
    author: text("author"),
    headSha: text("head_sha").notNull(),
    baseSha: text("base_sha").notNull(),
    headBranch: text("head_branch"),
    baseBranch: text("base_branch"),
    syncedAt: timestamp("synced_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    format("pull_request", t.publicId, "pullRequest"),
    uniqueIndex("pull_requests_repository_number").on(t.repositoryId, t.number),
    index("pull_requests_updated").on(t.updatedAt),
    check("pull_request_number", sql`${t.number} > 0`),
    check("pull_request_state", sql`${t.state} in ('open','closed')`),
    check(
      "pull_request_head_sha",
      sql`${t.headSha} ~ '^[a-f0-9]{40}([a-f0-9]{24})?$'`,
    ),
    check(
      "pull_request_base_sha",
      sql`${t.baseSha} ~ '^[a-f0-9]{40}([a-f0-9]{24})?$'`,
    ),
  ],
);

export const consoleUsers = pgTable(
  "console_users",
  {
    ...identity(),
    ...times(),
    username: text("username"),
    displayName: text("display_name"),
    email: text("email"),
    passwordHash: text("password_hash"),
    oidcIssuer: text("oidc_issuer"),
    oidcSubject: text("oidc_subject"),
    role: text("role").$type<"super_admin" | "user">().notNull(),
    enabled: boolean("enabled").notNull().default(true),
    mustChangePassword: boolean("must_change_password").notNull().default(true),
  },
  (t) => [
    format("console_user", t.publicId, "user"),
    uniqueIndex("console_users_username_unique").on(t.username),
    uniqueIndex("console_users_oidc_identity_unique").on(
      t.oidcIssuer,
      t.oidcSubject,
    ),
    check(
      "console_user_authentication",
      sql`(${t.oidcIssuer} is null and ${t.oidcSubject} is null and ${t.passwordHash} is not null and ${t.username} is not null) or (${t.oidcIssuer} is not null and ${t.oidcSubject} is not null and ${t.passwordHash} is null and ${t.username} is null and ${t.mustChangePassword} = false)`,
    ),
    check("console_user_role", sql`${t.role} in ('super_admin', 'user')`),
    check(
      "console_user_username",
      sql`${t.username} ~ '^[a-z0-9][a-z0-9._-]{2,63}$'`,
    ),
  ],
);

export const consoleUserRepositories = pgTable(
  "console_user_repositories",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => consoleUsers.id, { onDelete: "cascade" }),
    repositoryId: uuid("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.repositoryId] }),
    index("console_user_repositories_repository").on(t.repositoryId),
  ],
);

export const consoleSessions = pgTable(
  "console_sessions",
  {
    hash: text("hash").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => consoleUsers.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    check("console_session_hash", sql`${t.hash} ~ '^[a-f0-9]{64}$'`),
    index("console_sessions_user").on(t.userId),
    index("console_sessions_expiry").on(t.expiresAt),
  ],
);

export type OrganizationRole = "admin" | "moderator" | "member";

export const organizationMembers = pgTable(
  "organization_members",
  {
    contextId: uuid("context_id")
      .notNull()
      .references(() => accountContexts.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => consoleUsers.id, { onDelete: "cascade" }),
    role: text("role").$type<OrganizationRole>().notNull(),
    ...times(),
  },
  (t) => [
    primaryKey({ columns: [t.contextId, t.userId] }),
    index("organization_members_user").on(t.userId),
    check(
      "organization_member_role",
      sql`${t.role} in ('admin','moderator','member')`,
    ),
  ],
);

export const organizationRepositoryGrants = pgTable(
  "organization_repository_grants",
  {
    contextId: uuid("context_id").notNull(),
    userId: uuid("user_id").notNull(),
    repositoryId: uuid("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.contextId, t.userId, t.repositoryId] }),
    foreignKey({
      columns: [t.contextId, t.userId],
      foreignColumns: [
        organizationMembers.contextId,
        organizationMembers.userId,
      ],
    }).onDelete("cascade"),
  ],
);

export const organizationInvitations = pgTable(
  "organization_invitations",
  {
    ...identity(),
    ...times(),
    contextId: uuid("context_id")
      .notNull()
      .references(() => accountContexts.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => consoleUsers.id, { onDelete: "cascade" }),
    invitedBy: uuid("invited_by")
      .notNull()
      .references(() => consoleUsers.id),
    role: text("role").$type<OrganizationRole>().notNull(),
    repositoryIds: jsonb("repository_ids")
      .$type<string[]>()
      .notNull()
      .default([]),
    status: text("status")
      .$type<"pending" | "accepted" | "rejected" | "revoked">()
      .notNull()
      .default("pending"),
  },
  (t) => [
    format("organization_invitation", t.publicId, "invitation"),
    uniqueIndex("organization_invitations_pending_unique")
      .on(t.contextId, t.userId)
      .where(sql`${t.status} = 'pending'`),
    check(
      "organization_invitation_role",
      sql`${t.role} in ('admin','moderator','member')`,
    ),
    check(
      "organization_invitation_status",
      sql`${t.status} in ('pending','accepted','rejected','revoked')`,
    ),
    check(
      "organization_invitation_repositories",
      sql`jsonb_typeof(${t.repositoryIds}) = 'array'`,
    ),
  ],
);

export const repositoryMcpServers = pgTable(
  "repository_mcp_servers",
  {
    repositoryId: uuid("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    serverId: uuid("server_id")
      .notNull()
      .references(() => mcpServers.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.repositoryId, t.serverId] }),
    index("repository_mcp_servers_server").on(t.serverId),
  ],
);

export const runners = pgTable(
  "runners",
  {
    ...identity(),
    ...times(),
    name: text("name").notNull(),
    allRepositories: boolean("all_repositories").notNull().default(false),
    state: text("state")
      .$type<"enabled" | "draining" | "revoked">()
      .notNull()
      .default("enabled"),
    provisioningKey: text("provisioning_key").unique(),
    provisioningHash: text("provisioning_hash"),
    enrollmentHash: text("enrollment_hash").unique(),
    enrollmentExpiresAt: timestamp("enrollment_expires_at", {
      withTimezone: true,
    }),
    credentialHash: text("credential_hash").unique(),
    enrolledAt: timestamp("enrolled_at", { withTimezone: true }),
    sessionId: uuid("session_id"),
    sessionExpiresAt: timestamp("session_expires_at", { withTimezone: true }),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    capacity: integer("capacity").notNull().default(1),
    runtimeReady: boolean("runtime_ready").notNull().default(false),
    protocolVersion: integer("protocol_version").notNull().default(1),
    runtimeVersion: text("runtime_version"),
    timeoutMs: integer("timeout_ms").notNull().default(900000),
    fallbackModel: boolean("fallback_model").notNull().default(false),
  },
  (t) => [
    format("runner", t.publicId, "runner"),
    check("runner_state", sql`${t.state} in ('enabled','draining','revoked')`),
    check("runner_capacity", sql`${t.capacity} between 1 and 32`),
    check("runner_timeout", sql`${t.timeoutMs} between 1000 and 3600000`),
    check(
      "runner_provisioning_key_format",
      sql`${t.provisioningKey} ~ '^[A-Za-z0-9_-]{1,64}$'`,
    ),
    check(
      "runner_provisioning_hash_format",
      sql`${t.provisioningHash} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      "runner_provisioning_binding",
      sql`(${t.provisioningKey} is null) = (${t.provisioningHash} is null)`,
    ),
  ],
);

export const runnerRepositories = pgTable(
  "runner_repositories",
  {
    runnerId: uuid("runner_id")
      .notNull()
      .references(() => runners.id, { onDelete: "cascade" }),
    repositoryId: uuid("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.runnerId, t.repositoryId] })],
);

const memorySearch = customType<{ data: string }>({
  /** Expose PostgreSQL's generated full-text search vector as a read-only value. */
  dataType() {
    return "tsvector";
  },
});

export const memoryCollections = pgTable(
  "memory_collections",
  {
    ...identity(),
    ...times(),
    name: text("name").notNull(),
  },
  (t) => [format("memory_collection", t.publicId, "memoryCollection")],
);

export const repositoryMemoryCollections = pgTable(
  "repository_memory_collections",
  {
    repositoryId: uuid("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    collectionId: uuid("collection_id")
      .notNull()
      .references(() => memoryCollections.id, { onDelete: "cascade" }),
    canWrite: boolean("can_write").notNull().default(false),
    isDefault: boolean("is_default").notNull().default(false),
  },
  (t) => [
    primaryKey({ columns: [t.repositoryId, t.collectionId] }),
    uniqueIndex("repository_memory_default")
      .on(t.repositoryId)
      .where(sql`${t.isDefault}`),
    index("repository_memory_collection").on(t.collectionId),
    check(
      "repository_memory_default_writable",
      sql`not ${t.isDefault} or ${t.canWrite}`,
    ),
  ],
);

export const memoryDocuments = pgTable(
  "memory_documents",
  {
    ...identity(),
    ...times(),
    collectionId: uuid("collection_id")
      .notNull()
      .references(() => memoryCollections.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    title: text("title").notNull(),
    markdown: text("markdown").notNull(),
    version: integer("version").notNull().default(1),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    search: memorySearch("search").generatedAlwaysAs(
      sql`setweight(to_tsvector('simple', coalesce(title, '')), 'A') || setweight(to_tsvector('simple', coalesce(path, '')), 'B') || to_tsvector('simple', coalesce(markdown, ''))`,
    ),
  },
  (t) => [
    format("memory_document", t.publicId, "memory"),
    uniqueIndex("memory_document_path").on(t.collectionId, t.path),
    index("memory_document_search").using("gin", t.search),
    check("memory_document_version", sql`${t.version} > 0`),
    check("memory_document_bytes", sql`octet_length(${t.markdown}) <= 65536`),
    check(
      "memory_document_path_format",
      sql`length(${t.path}) between 1 and 512 and ${t.path} ~ '\\.md$' and ${t.path} !~ '(^|/)(\\.\\.?|)(/|$)' and ${t.path} !~ '[[:cntrl:]]' and position(chr(92) in ${t.path}) = 0`,
    ),
    check(
      "memory_document_title",
      sql`length(${t.title}) between 1 and 200 and ${t.title} !~ '[[:cntrl:]]'`,
    ),
  ],
);

export const memoryRevisions = pgTable(
  "memory_revisions",
  {
    documentId: uuid("document_id")
      .notNull()
      .references(() => memoryDocuments.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    path: text("path").notNull(),
    title: text("title").notNull(),
    markdown: text("markdown").notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    actor: text("actor").$type<"human" | "bot">().notNull(),
    reviewId: text("review_id"),
    headSha: text("head_sha"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.documentId, t.version] }),
    check("memory_revision_version", sql`${t.version} > 0`),
    check("memory_revision_actor", sql`${t.actor} in ('human', 'bot')`),
    check("memory_revision_bytes", sql`octet_length(${t.markdown}) <= 65536`),
    check(
      "memory_revision_review",
      sql`${t.reviewId} is null or ${t.reviewId} ~ ${sql.raw(`'${publicIdPattern("review")}'`)}`,
    ),
    check(
      "memory_revision_head",
      sql`${t.headSha} is null or ${t.headSha} ~ '^[a-f0-9]{40}([a-f0-9]{24})?$'`,
    ),
  ],
);

export const storedSecrets = pgTable("stored_secrets", {
  id: uuid("id").primaryKey().defaultRandom(),
  repositoryId: uuid("repository_id")
    .notNull()
    .references(() => repositories.id, { onDelete: "cascade" }),
  value: text("value").notNull(),
});

export const reviews = pgTable(
  "reviews",
  {
    ...identity(),
    ...times(),
    repositoryId: uuid("repository_id")
      .notNull()
      .references(() => repositories.id),
    baseSha: text("base_sha").notNull(),
    headSha: text("head_sha").notNull(),
    // Pins source policy and prior findings for this run; never secret values.
    source: jsonb("source")
      .$type<{
        configKey: string;
        git: GitPolicy;
        indexOwner: string;
        headBranch?: string;
        baseBranch?: string;
        pullRequest?: {
          number: number;
          title: string;
          url: string;
          baseSha: string;
        };
        agent?: ReviewAgentSnapshot;
        guidance?: ReviewGuidanceSnapshot;
        mcpServers?: McpServerSnapshot[];
        previousFindings?: PreviousFinding[];
        conversation?: ReviewConversation;
      }>()
      .notNull(),
    status: text("status")
      .$type<"queued" | "running" | "completed" | "failed">()
      .notNull()
      .default("queued"),
    version: integer("version").notNull().default(0),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    result: jsonb("result").$type<ReviewResult>(),
    evaluation: jsonb("evaluation")
      .$type<ReviewEvaluation>()
      .notNull()
      .default({ included: false, findings: {} }),
  },
  (t) => [
    format("review", t.publicId, "review"),
    index("reviews_created").on(t.createdAt),
    index("reviews_queued_without_agent")
      .on(t.repositoryId)
      .where(sql`${t.status} = 'queued' and ${t.source}->'agent' is null`),
    check(
      "reviews_status",
      sql`${t.status} in ('queued','running','completed','failed')`,
    ),
    check(
      "review_evaluation_object",
      sql`jsonb_typeof(${t.evaluation}) = 'object'`,
    ),
  ],
);

export const reviewAttempts = pgTable(
  "review_attempts",
  {
    ...identity(),
    ...times(),
    reviewId: uuid("review_id")
      .notNull()
      .references(() => reviews.id),
    version: integer("version").notNull(),
    owner: text("owner").notNull(),
    runnerId: uuid("runner_id").references(() => runners.id),
    runnerSessionId: uuid("runner_session_id"),
    deadline: timestamp("deadline", { withTimezone: true }),
    status: text("status")
      .$type<"running" | "completed" | "failed" | "abandoned">()
      .notNull(),
    leaseUntil: timestamp("lease_until", { withTimezone: true }).notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    metrics: jsonb("metrics").$type<ReviewAttemptMetrics>(),
  },
  (t) => [
    format("attempt", t.publicId, "attempt"),
    uniqueIndex("attempt_version").on(t.reviewId, t.version),
    index("attempt_runner_capacity").on(
      t.runnerId,
      t.runnerSessionId,
      t.status,
      t.leaseUntil,
    ),
    check(
      "attempt_runner_binding",
      sql`(${t.runnerId} is null and ${t.runnerSessionId} is null and ${t.deadline} is null) or (${t.runnerId} is not null and ${t.runnerSessionId} is not null and ${t.deadline} is not null)`,
    ),
    check(
      "attempt_status",
      sql`${t.status} in ('running','completed','failed','abandoned')`,
    ),
    check(
      "attempt_metrics_object",
      sql`${t.metrics} is null or jsonb_typeof(${t.metrics}) = 'object'`,
    ),
  ],
);

export const reviewLogs = pgTable(
  "review_logs",
  {
    reviewId: uuid("review_id")
      .notNull()
      .references(() => reviews.id, { onDelete: "cascade" }),
    attemptId: uuid("attempt_id")
      .notNull()
      .references(() => reviewAttempts.id, { onDelete: "cascade" }),
    sequence: integer("sequence").notNull(),
    event: jsonb("event").$type<ReviewLog>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.reviewId, t.sequence] }),
    index("review_logs_attempt").on(t.attemptId),
    check("review_logs_sequence", sql`${t.sequence} > 0`),
    check("review_logs_event_object", sql`jsonb_typeof(${t.event}) = 'object'`),
  ],
);

export const indexWorkspaces = pgTable(
  "index_workspaces",
  {
    ...identity(),
    ...times(),
    repositoryId: uuid("repository_id")
      .notNull()
      .references(() => repositories.id),
    attemptId: uuid("attempt_id").references(() => reviewAttempts.id),
    owner: text("owner").notNull(),
    root: text("root").notNull(),
    temporary: boolean("temporary").notNull(),
    git: jsonb("git").$type<GitPolicy>().notNull(),
    state: text("state")
      .$type<"unready" | "ready" | "deleting" | "deleted">()
      .notNull()
      .default("unready"),
    baseSha: text("base_sha"),
    headSha: text("head_sha"),
    indexSha: text("index_sha"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    legacyKey: text("legacy_key"),
  },
  (t) => [
    format("workspace", t.publicId, "workspace"),
    uniqueIndex("workspace_root").on(t.owner, t.root),
    uniqueIndex("workspace_development")
      .on(t.repositoryId)
      .where(sql`not ${t.temporary}`),
    uniqueIndex("workspace_attempt").on(t.attemptId),
    uniqueIndex("workspace_legacy").on(t.owner, t.legacyKey),
    index("workspace_cleanup").on(t.owner, t.state, t.expiresAt),
    check(
      "workspace_state",
      sql`${t.state} in ('unready','ready','deleting','deleted')`,
    ),
    check(
      "workspace_revision_binding",
      sql`${t.state} <> 'ready' or (${t.headSha} is not null and ${t.indexSha} is not null and (${t.temporary} or ${t.indexSha} = ${t.headSha}))`,
    ),
  ],
);

export const indexAccessTokens = pgTable(
  "index_access_tokens",
  {
    ...identity(),
    ...times(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => indexWorkspaces.id),
    hash: text("hash").notNull().unique(),
    algorithm: text("algorithm").notNull().default("sha256"),
    refresh: boolean("refresh").notNull(),
    allRepositories: boolean("all_repositories").notNull().default(false),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    legacyKey: text("legacy_key"),
  },
  (t) => [
    format("token", t.publicId, "token"),
    check(
      "token_hash",
      sql`${t.algorithm} = 'sha256' and ${t.hash} ~ '^[a-f0-9]{64}$'`,
    ),
    index("tokens_workspace").on(t.workspaceId),
  ],
);

// The token's original workspace remains its primary binding; this table adds
// repository grants while preserving existing and imported single-project keys.
export const indexAccessTokenWorkspaces = pgTable(
  "index_access_token_workspaces",
  {
    tokenId: uuid("token_id")
      .notNull()
      .references(() => indexAccessTokens.id),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => indexWorkspaces.id),
  },
  (t) => [
    primaryKey({ columns: [t.tokenId, t.workspaceId] }),
    index("token_workspaces_workspace").on(t.workspaceId),
  ],
);

// Legacy revocations can outlive removed TOML entries. Preserve those tombstones
// without inventing a repository binding or allowing hash reuse to reactivate them.
export const legacyRevocations = pgTable(
  "legacy_revocations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    hash: text("hash").notNull().unique(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [check("legacy_revocation_hash", sql`${t.hash} ~ '^[a-f0-9]{64}$'`)],
);

export const dispatchOutbox = pgTable("dispatch_outbox", {
  id: uuid("id").primaryKey().defaultRandom(),
  reviewId: uuid("review_id")
    .notNull()
    .unique()
    .references(() => reviews.id),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  dispatchedAt: timestamp("dispatched_at", { withTimezone: true }),
  acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
  acknowledgement: jsonb("acknowledgement").$type<{
    writing?: boolean;
    remoteId?: string;
    error?: string;
  }>(),
  publication: jsonb("publication").$type<Publication>(),
  interactionAfter: timestamp("interaction_after", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type Publication = {
  state:
    "pending" | "publishing" | "published" | "failed" | "uncertain" | "stale";
  remoteId?: string;
  inlineIds?: string[];
  providerProgress?: ForgePublicationProgress;
  /** Freeze provider input before the first write so multi-step retries stay identical. */
  reviewPayload?: {
    body: string;
    comments: InlineComment[];
    event: "COMMENT" | "REQUEST_CHANGES";
    /** Existing bot-owned recap to edit independently of new inline review records. */
    recapReviewId?: string;
  };
  limitations?: string[];
  error?: string;
  writing?: boolean;
  mode?: "review" | "comment" | "recap";
  stale?: boolean;
};

export const repositoryWebhooks = pgTable(
  "repository_webhooks",
  {
    ...identity(),
    ...times(),
    repositoryId: uuid("repository_id")
      .notNull()
      .unique()
      .references(() => repositories.id),
    managedBy: text("managed_by").notNull(),
    mode: text("mode")
      .$type<"managed" | "manual" | "github-app">()
      .notNull()
      .default("managed"),
    enabled: boolean("enabled").notNull(),
    callbackBase: text("callback_base").notNull(),
    secret: jsonb("secret").$type<SecretReference>().notNull(),
    senders: jsonb("senders").$type<string[]>().notNull(),
    remoteId: text("remote_id"),
    botId: text("bot_id"),
    setup: text("setup").notNull().default("pending"),
    lastDelivery: text("last_delivery"),
    lastDeliveryAt: timestamp("last_delivery_at", { withTimezone: true }),
  },
  (t) => [
    format("webhook", t.publicId, "webhook"),
    check(
      "repository_webhooks_mode_check",
      sql`${t.mode} in ('managed', 'manual', 'github-app')`,
    ),
  ],
);

export const reviewTriggers = pgTable(
  "review_triggers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    webhookId: uuid("webhook_id")
      .notNull()
      .references(() => repositoryWebhooks.id),
    repositoryId: uuid("repository_id")
      .notNull()
      .references(() => repositories.id),
    reviewId: uuid("review_id")
      .notNull()
      .unique()
      .references(() => reviews.id),
    commentId: text("comment_id").notNull(),
    change: jsonb("change").$type<ForgeChange>().notNull(),
  },
  (t) => [
    uniqueIndex("trigger_comment_identity").on(t.repositoryId, t.commentId),
  ],
);

export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    webhookId: uuid("webhook_id")
      .notNull()
      .references(() => repositoryWebhooks.id),
    deliveryId: text("delivery_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex("delivery_identity").on(t.webhookId, t.deliveryId)],
);
