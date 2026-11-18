import assert from "node:assert/strict";
import { test } from "node:test";

import { registrySchema } from "@razbor/database/registry";

test("registry defaults existing repositories to indexed reviews independently of persistent provisioning", () => {
  const repository = {
    git: {
      branch: "main",
      upstream: "refs/remotes/origin/main",
      remotes: { origin: "https://example.invalid/repo.git" },
    },
    indexing: { owner: "fixture", persistent: false },
  };
  const config = {
    registry: { key: "fixture" },
    repositories: {
      existing: repository,
      disabled: { ...repository, codebaseMemoryEnabled: false },
    },
  };
  const { repositories } = registrySchema.parse(config);
  assert.equal(repositories.existing.codebaseMemoryEnabled, true);
  assert.equal(repositories.disabled.codebaseMemoryEnabled, false);
  assert.equal(
    registrySchema.safeParse({
      ...config,
      repositories: {
        invalid: { ...repository, codebaseMemoryEnabled: "false" },
      },
    }).success,
    false,
  );
});
