CREATE INDEX "reviews_queued_without_agent" ON "reviews" ("repository_id")
WHERE "status" = 'queued' AND "source"->'agent' IS NULL;
