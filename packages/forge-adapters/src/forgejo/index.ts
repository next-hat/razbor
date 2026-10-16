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
 * Fetch and normalize Forgejo repository metadata using optional token
 * authentication and lossless provider IDs.
 */
export async function readForgejo(
  c: ForgeConnection,
  selector: string,
  signal?: AbortSignal,
): Promise<RepositoryMetadata> {
  const data = schema.parse(
    await readJson(
      c,
      `repos/${repositoryPath(selector)}`,
      c.token ? { Authorization: `token ${c.token}` } : {},
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
 * Verify bot identity, active repository metadata and the requested branch,
 * requiring exact HTTPS web and clone locations before registration.
 */
export async function verifyForgejoRegistration(
  connection: ForgeConnection,
  selector: string,
  requestedBranch?: string,
  signal?: AbortSignal,
) {
  try {
    if (connection.type !== "forgejo" || !connection.token)
      throw new ForgeReadError("unauthorized");
    const headers = { Authorization: `token ${connection.token}` };
    const identity = z
      .object({
        id: providerId,
        login: z
          .string()
          .min(1)
          .max(200)
          .regex(/^[^:\r\n\0]+$/),
      })
      .parse(await readJson(connection, "user", headers, signal));
    const repository = schema
      .extend({
        clone_url: z.string().url(),
      })
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
        commit: z.object({ id: z.string().regex(/^[a-f0-9]{40,64}$/i) }),
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
    return { metadata, identity, branch, cloneUrl: clone.href };
  } catch (error) {
    if (error instanceof ForgeReadError) throw error;
    throw new ForgeReadError("invalid-response");
  }
}
