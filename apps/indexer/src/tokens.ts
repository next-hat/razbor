import { timingSafeEqual } from "node:crypto";

import {
  authorizeHash,
  issueToken,
  revokeToken,
  tokenHash,
  type Database,
} from "@razbor/database";

export { tokenHash } from "@razbor/database";

export type AccessGrant = {
  id: string;
  repository: string;
  workspace: string;
  scopes: { workspace: string; repository: string; name: string }[];
  multipleProjects: boolean;
  refresh: boolean;
  expiresAt?: number;
  stop: AbortController;
};

export class Tokens {
  private readonly active = new Map<string, AccessGrant>();
  private readonly adminHash: string;

  /** Bind grants to one index owner and retain only a hash of the management secret. */
  constructor(
    private readonly database: Database,
    private readonly owner: string,
    admin: string,
  ) {
    this.adminHash = tokenHash(admin);
  }

  /** Compare hashed management credentials in constant time. */
  isAdmin(token: string) {
    return timingSafeEqual(
      Buffer.from(tokenHash(token), "hex"),
      Buffer.from(this.adminHash, "hex"),
    );
  }

  /** Hash the presented token and authorize it against current database state. */
  async authorize(token: string) {
    return this.authorizeHash(tokenHash(token));
  }

  /**
   * Require a current grant containing the requested repository before returning its
   * cancellation scope.
   */
  async authorizeRepository(token: string, repositoryId: string) {
    const grant = await this.authorize(token);
    if (!grant.scopes.some((scope) => scope.repository === repositoryId))
      throw new Error("token does not authorize this repository");
    return grant;
  }

  /** Require a current grant for the exact workspace and repository pair. */
  async authorizeWorkspace(
    token: string,
    workspaceId: string,
    repositoryId: string,
  ) {
    const grant = await this.authorize(token);
    if (
      !grant.scopes.some(
        (scope) =>
          scope.workspace === workspaceId && scope.repository === repositoryId,
      )
    )
      throw new Error("token does not authorize this workspace");
    return grant;
  }

  /**
   * Reload authoritative grant state on every call; abort prior work when its scope changes
   * or authorization fails, including database outages.
   */
  private async authorizeHash(hash: string) {
    try {
      const record = await authorizeHash(this.database, hash, this.owner);
      const previous = this.active.get(hash);
      const changed =
        previous &&
        (previous.workspace !== record.workspace ||
          previous.scopes.length !== record.scopes.length ||
          previous.scopes.some(
            (scope, index) =>
              scope.workspace !== record.scopes[index]?.workspace,
          ));
      if (changed) previous.stop.abort();
      const grant = {
        ...record,
        stop: changed
          ? new AbortController()
          : (previous?.stop ?? new AbortController()),
      };
      if (grant.stop.signal.aborted) throw new Error("token revoked");
      this.active.set(hash, grant);
      return grant;
    } catch (error) {
      this.active.get(hash)?.stop.abort();
      this.active.delete(hash);
      throw error;
    }
  }

  /**
   * Revalidate active grants so revocation and database failures cancel in-flight sessions
   * even when no new request arrives.
   */
  async poll() {
    // No authorization cache: this cancels in-flight sessions on revocation or a
    // database outage; every request and tool call also queries authoritative state.
    await Promise.all(
      [...this.active.keys()].map((hash) =>
        this.authorizeHash(hash).catch(() => {}),
      ),
    );
  }

  /** Issue an expiring token for an owned workspace without granting refresh permission. */
  async issue(workspace: string, ttl: number) {
    return issueToken(this.database, workspace, this.owner, {
      refresh: false,
      ttlMs: ttl,
    });
  }

  /** Abort and forget every active grant that includes the workspace being removed. */
  cancelWorkspace(id: string) {
    for (const [hash, grant] of this.active)
      if (grant.scopes.some((scope) => scope.workspace === id)) {
        grant.stop.abort();
        this.active.delete(hash);
      }
  }

  /**
   * Revoke a stored token and immediately revalidate active grants to propagate
   * cancellation.
   */
  async revoke(id: string) {
    await revokeToken(this.database, id, this.owner);
    await this.poll();
  }

  /** Abort all active grants and discard their in-memory lifecycle state. */
  close() {
    for (const grant of this.active.values()) grant.stop.abort();
    this.active.clear();
  }
}
