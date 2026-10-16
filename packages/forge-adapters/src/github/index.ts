import { z } from "zod";

import {
  approvedUrl,
  ForgeReadError,
  providerId,
  readJson,
  repositoryPath,
} from "@forge-adapters/src/http.js";
import type {
  ForgeConnection,
  RepositoryMetadata,
} from "@forge-adapters/src/types.js";

const schema = z.object({
  id: providerId,
  full_name: z.string().min(1),
  html_url: z.string().url(),
  default_branch: z.string().optional(),
  private: z.boolean(),
  archived: z.boolean(),
});

/**
 * Fetch and validate GitHub repository metadata, preserving provider IDs
 * without numeric precision loss.
 */
export async function readGithub(
  c: ForgeConnection,
  selector: string,
  signal?: AbortSignal,
): Promise<RepositoryMetadata> {
  const data = schema.parse(
    await readJson(
      c,
      `repos/${repositoryPath(selector)}`,
      {
        "X-GitHub-Api-Version": "2022-11-28",
        ...(c.token ? { Authorization: `Bearer ${c.token}` } : {}),
      },
      signal,
    ),
  );
  return {
    externalRepositoryId: data.id,
    fullPath: data.full_name,
    webUrl: data.html_url,
    defaultBranch: data.default_branch,
    visibility: data.private ? "private" : "public",
    archived: data.archived,
  };
}

/**
 * Verify a token owner, repository identity and requested branch against the
 * configured GitHub origin before persisting clone credentials.
 */
export async function verifyGithubRegistration(
  connection: ForgeConnection,
  selector: string,
  requestedBranch?: string,
  signal?: AbortSignal,
) {
  try {
    if (connection.type !== "github" || !connection.token)
      throw new ForgeReadError("unauthorized");
    const headers = {
      Authorization: `Bearer ${connection.token}`,
      "X-GitHub-Api-Version": "2022-11-28",
    };
    const identity = z
      .object({
        id: providerId,
        login: z
          .string()
          .min(1)
          .max(200)
          .regex(/^[^:\r\n\0]+$/),
      })
      .parse(
        connection.githubAppBot ??
          (await readJson(connection, "user", headers, signal)),
      );
    const repository = schema
      .extend({ clone_url: z.string().url() })
      .parse(
        await readJson(
          connection,
          `repos/${repositoryPath(selector)}`,
          headers,
          signal,
        ),
      );
    const web = approvedUrl(connection.webUrl, false);
    const fullPath = repositoryPath(repository.full_name);
    const expectedPath = `${web.pathname.replace(/\/$/, "")}/${fullPath}`;
    const html = approvedUrl(repository.html_url, false);
    const clone = approvedUrl(repository.clone_url, false);
    if (
      html.origin !== web.origin ||
      html.pathname !== expectedPath ||
      clone.origin !== web.origin ||
      clone.pathname !== `${expectedPath}.git` ||
      repository.full_name.toLowerCase() !== selector.toLowerCase() ||
      repository.archived
    )
      throw new ForgeReadError("invalid-response");
    const branch = requestedBranch || repository.default_branch;
    if (!branch) throw new ForgeReadError("not-found");
    const resolvedBranch = z
      .object({
        name: z.string(),
        commit: z.object({ sha: z.string().regex(/^[a-f0-9]{40,64}$/i) }),
      })
      .parse(
        await readJson(
          connection,
          `repos/${fullPath}/branches/${encodeURIComponent(branch)}`,
          headers,
          signal,
        ),
      );
    if (resolvedBranch.name !== branch)
      throw new ForgeReadError("invalid-response");
    const metadata: RepositoryMetadata = {
      externalRepositoryId: repository.id,
      fullPath: repository.full_name,
      webUrl: repository.html_url,
      defaultBranch: repository.default_branch,
      visibility: repository.private ? "private" : "public",
      archived: repository.archived,
    };
    return {
      metadata,
      identity,
      branch,
      cloneUrl: clone.href,
      gitUsername: connection.githubAppBot ? "x-access-token" : identity.login,
    };
  } catch (error) {
    if (error instanceof ForgeReadError) throw error;
    throw new ForgeReadError("invalid-response");
  }
}
