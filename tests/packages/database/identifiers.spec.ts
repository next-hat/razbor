import assert from "node:assert/strict";
import { test } from "node:test";

import {
  publicIdPrefixes,
  publicIdSchema,
  reviewRequestSchema,
} from "@razbor/contracts";
import { publicId, retryPublicIdCollision } from "@razbor/database/ids";

test("secure public IDs use centralized case-sensitive prefixes and alphabet", () => {
  for (const kind of Object.keys(
    publicIdPrefixes,
  ) as (keyof typeof publicIdPrefixes)[]) {
    const ids = new Set(Array.from({ length: 100 }, () => publicId(kind)));
    assert.equal(ids.size, 100);
    for (const id of ids) assert.ok(publicIdSchema(kind).safeParse(id).success);
    assert.ok(
      !publicIdSchema(kind).safeParse("00000000-0000-4000-8000-000000000000")
        .success,
    );
  }
  assert.ok(
    !reviewRequestSchema.safeParse({
      repositoryId: "fixture",
      baseSha: "a".repeat(40),
      headSha: "b".repeat(40),
    }).success,
  );
});

test("collision retries only named public-ID unique constraints and stop after three transactions", async () => {
  let calls = 0;
  const collision = { code: "23505", constraint: "reviews_public_id_unique" };
  await assert.rejects(
    retryPublicIdCollision(async () => {
      calls++;
      throw { cause: collision };
    }),
  );
  assert.equal(calls, 3);
  for (const error of [
    { code: "23505", constraint: "repositories_config_key_key" },
    { code: "23503", constraint: "reviews_public_id_unique" },
    { code: "40001" },
  ]) {
    calls = 0;
    await assert.rejects(
      retryPublicIdCollision(async () => {
        calls++;
        throw error;
      }),
    );
    assert.equal(calls, 1);
  }
  calls = 0;
  assert.equal(
    await retryPublicIdCollision(async () => {
      if (++calls === 1) throw collision;
      return "inserted";
    }),
    "inserted",
  );
});
