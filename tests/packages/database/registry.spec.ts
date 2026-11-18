import assert from "node:assert/strict";
import { test } from "node:test";

import { registrySchema } from "@razbor/database/registry";

test("registry preserves omitted and explicit Codebase Memory preferences independently of persistent provisioning", () => {
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
      enabled: { ...repository, codebaseMemoryEnabled: true },
      disabled: { ...repository, codebaseMemoryEnabled: false },
    },
  };
  const { repositories } = registrySchema.parse(config);
  assert.equal(repositories.existing.codebaseMemoryEnabled, undefined);
  assert.equal(repositories.enabled.codebaseMemoryEnabled, true);
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

test("registry accepts each trigger policy independently of indexing and rejects unknown policies", () => {
  const repository = {
    git: {
      branch: "main",
      upstream: "refs/remotes/origin/main",
      remotes: { origin: "https://example.invalid/r.git" },
    },
    indexing: { owner: "fixture" },
  };
  for (const codebaseMemoryEnabled of [true, false]) {
    for (const reviewTriggerMode of [
      "manual",
      "opt_in_continuous",
      "automatic",
      "always",
    ]) {
      const parsed = registrySchema.safeParse({
        registry: { key: "file" },
        repositories: {
          project: { ...repository, codebaseMemoryEnabled, reviewTriggerMode },
        },
      });
      assert.equal(parsed.success, reviewTriggerMode !== "always");
      if (parsed.success)
        assert.equal(
          parsed.data.repositories.project.reviewTriggerMode,
          reviewTriggerMode,
        );
    }
  }
});
