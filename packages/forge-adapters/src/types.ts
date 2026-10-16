export type ForgeType = "github" | "gitlab" | "forgejo";

export type ForgeConnection = {
  type: ForgeType;
  apiUrl: string;
  webUrl: string;
  allowHttp: boolean;
  token?: string;
  /** Provider-verified App identity, supplied only by trusted credential resolution. */
  githubAppBot?: { id: string; login: string };
  timeoutMs?: number;
};

export type RepositoryMetadata = {
  externalRepositoryId: string;
  fullPath: string;
  webUrl: string;
  defaultBranch?: string;
  visibility: "public" | "private" | "internal";
  archived: boolean;
};

export type ReviewRevision = {
  baseSha: string;
  headSha: string;
  startSha?: string;
};

export type DiffLocation = {
  revision: ReviewRevision;
  path: string;
  oldPath?: string;
  side: "old" | "new";
  startLine: number;
  endLine: number;
};

export type FixAdvice =
  | { kind: "advice"; text: string }
  | {
      kind: "replacement";
      location: DiffLocation;
      code: string;
    };

export type Discussion = {
  externalDiscussionId: string;
  comments: { externalCommentId: string; body: string }[];
};

export type {
  ForgeWebhook as NormalizedWebhook,
  Forge as ReviewInteractions,
} from "@forge-adapters/src/interactions.js";
