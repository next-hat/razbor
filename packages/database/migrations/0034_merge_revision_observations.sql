-- Listings omit diff refs. A first detailed observation that confirms the saved
-- target tip as the comparison base/start does not supersede a console review.
CREATE OR REPLACE FUNCTION razbor_merge_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.head_sha, NEW.base_sha, NEW.head_branch, NEW.base_branch, NEW.state, NEW.draft,
         NEW.merge_base, NEW.start_sha)
     IS DISTINCT FROM ROW(OLD.head_sha, OLD.base_sha, OLD.head_branch, OLD.base_branch,
                          OLD.state, OLD.draft, OLD.merge_base, OLD.start_sha) THEN
    NEW.merge_after := now();
    IF ROW(NEW.head_sha, NEW.base_sha, NEW.head_branch, NEW.base_branch, NEW.state, NEW.draft)
       IS DISTINCT FROM ROW(OLD.head_sha, OLD.base_sha, OLD.head_branch, OLD.base_branch, OLD.state, OLD.draft)
       OR (NEW.merge_base IS DISTINCT FROM OLD.merge_base
           AND (OLD.merge_base IS NOT NULL OR NEW.merge_base IS DISTINCT FROM OLD.base_sha))
       OR (NEW.start_sha IS DISTINCT FROM OLD.start_sha
           AND (OLD.start_sha IS NOT NULL OR NEW.start_sha IS DISTINCT FROM OLD.base_sha)) THEN
      NEW.merge_revision := OLD.merge_revision + 1;
    END IF;
  END IF;
  RETURN NEW;
END $$;
