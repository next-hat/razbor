import {
  connectDatabase,
  databaseUrl,
  resolveRepository,
  submitReview,
} from "@razbor/database";
import { git } from "@razbor/harness/git";
import { reviewRequestSchema } from "@razbor/contracts";

const [
  repositoryKey = "razbor",
  repository = process.cwd(),
  base = "master",
  head = "HEAD",
] = process.argv.slice(2);

/** Resolve a revision to a verified commit SHA in the selected local repository. */
const resolve = (revision: string) =>
  git(repository, [
    "rev-parse",
    "--verify",
    "--end-of-options",
    `${revision}^{commit}`,
  ]);

/**
 * Capture a local branch label for reporting; tags, raw SHAs, and detached HEADs
 * remain unattributed rather than being guessed from repository policy.
 */
async function resolveBranch(revision: string) {
  const ref = await git(repository, [
    "rev-parse",
    "--symbolic-full-name",
    "--verify",
    "--end-of-options",
    revision,
  ]);
  return ref.startsWith("refs/heads/")
    ? ref.slice("refs/heads/".length)
    : undefined;
}

const database = connectDatabase(await databaseUrl());

try {
  await database.ready();
  const repositoryId = await resolveRepository(database, repositoryKey);
  const payload = reviewRequestSchema.parse({
    repositoryId,
    baseSha: await resolve(base),
    headSha: await resolve(head),
    headBranch: await resolveBranch(head),
    baseBranch: await resolveBranch(base),
  });
  // The operator already supplies database credentials; retain that trusted CLI
  // path without requiring a browser session or an anonymous HTTP endpoint.
  console.log(JSON.stringify(await submitReview(database, payload)));
} finally {
  await database.close();
}
