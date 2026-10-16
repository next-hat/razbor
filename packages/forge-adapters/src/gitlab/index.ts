import { z } from "zod";

import {
  approvedUrl,
  ForgeReadError,
  providerId,
  readJson,
} from "@forge-adapters/src/http.js";
import type {
  ForgeConnection,
  RepositoryMetadata,
} from "@forge-adapters/src/types.js";

const schema = z.object({
  id: providerId,
  path_with_namespace: z.string().min(1),
  web_url: z.string().url(),
  default_branch: z.string().nullable().optional(),
  visibility: z.enum(["public", "private", "internal"]),
  archived: z.boolean(),
});

/**
 * Resolve a validated GitLab project selector and normalize its metadata,
 * retaining internal visibility and lossless provider IDs.
 */
export async function readGitlab(
  c: ForgeConnection,
  selector: string,
  signal?: AbortSignal,
): Promise<RepositoryMetadata> {
  if (
    selector.split("/").some((part) => !part || part === "." || part === "..")
  )
    throw new Error("invalid project selector");
  const data = schema.parse(
    await readJson(
      c,
      `projects/${encodeURIComponent(selector)}`,
      c.token ? { "PRIVATE-TOKEN": c.token } : {},
      signal,
    ),
  );
  return {
    externalRepositoryId: data.id,
    fullPath: data.path_with_namespace,
    webUrl: data.web_url,
    defaultBranch: data.default_branch ?? undefined,
    visibility: data.visibility,
    archived: data.archived,
  };
}

/**
 * Verify the bot, nested project path, HTTPS clone location and requested
 * branch before storing a GitLab repository binding.
 */
export async function verifyGitlabRegistration(
  connection: ForgeConnection,
  selector: string,
  requestedBranch?: string,
  signal?: AbortSignal,
) {
  try {
    if (connection.type !== "gitlab" || !connection.token)
      throw new ForgeReadError("unauthorized");
    const parts = selector.split("/");
    if (
      parts.length < 2 ||
      parts.some((part) => !part || part === "." || part === "..")
    )
      throw new ForgeReadError("invalid-response");
    const headers = { "PRIVATE-TOKEN": connection.token };
    const bot = z
      .object({
        id: providerId,
        username: z
          .string()
          .min(1)
          .max(200)
          .regex(/^[^:\r\n\0]+$/),
      })
      .parse(await readJson(connection, "user", headers, signal));
    const repository = schema
      .extend({ http_url_to_repo: z.string().url() })
      .parse(
        await readJson(
          connection,
          `projects/${encodeURIComponent(selector)}`,
          headers,
          signal,
        ),
      );
    const web = approvedUrl(connection.webUrl, false);
    const expectedPath = `${web.pathname.replace(/\/$/, "")}/${parts.map(encodeURIComponent).join("/")}`;
    const html = approvedUrl(repository.web_url, false);
    const clone = approvedUrl(repository.http_url_to_repo, false);
    if (
      repository.path_with_namespace !== selector ||
      html.origin !== web.origin ||
      html.pathname !== expectedPath ||
      clone.origin !== web.origin ||
      clone.pathname !== `${expectedPath}.git` ||
      repository.archived
    )
      throw new ForgeReadError("invalid-response");
    const branch = requestedBranch || repository.default_branch;
    if (!branch) throw new ForgeReadError("not-found");
    const resolved = z
      .object({
        name: z.string(),
        commit: z.object({
          id: z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i),
        }),
      })
      .parse(
        await readJson(
          connection,
          `projects/${encodeURIComponent(repository.id)}/repository/branches/${encodeURIComponent(branch)}`,
          headers,
          signal,
        ),
      );
    if (resolved.name !== branch) throw new ForgeReadError("invalid-response");
    const metadata: RepositoryMetadata = {
      externalRepositoryId: repository.id,
      fullPath: repository.path_with_namespace,
      webUrl: repository.web_url,
      defaultBranch: repository.default_branch ?? undefined,
      visibility: repository.visibility,
      archived: repository.archived,
    };
    return {
      metadata,
      identity: { id: bot.id, login: bot.username },
      branch,
      cloneUrl: clone.href,
      gitUsername: "oauth2",
    };
  } catch (error) {
    if (error instanceof ForgeReadError) throw error;
    throw new ForgeReadError("invalid-response");
  }
}
