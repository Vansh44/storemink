-- Removing a platform operator must not be blocked by Theme Studio history.
--
-- Studio rows record who created them in `created_by`, a foreign key to
-- platform_admins with ON DELETE SET NULL, and several of those tables are
-- immutable by trigger. The two contradict each other: deleting an operator
-- makes Postgres UPDATE their rows to set created_by NULL, the immutability
-- trigger refuses that UPDATE, and the whole delete fails. So an operator who
-- had ever uploaded a reference image (theme_studio_assets, since Phase 2),
-- written a brief (theme_studio_messages) or run an acceptance check
-- (theme_studio_acceptance_runs, 0131) could not be removed from the console.
--
-- The fix admits exactly ONE change on an immutable row: `created_by` going
-- from a value to NULL with every other column unchanged — which is precisely
-- and only what the foreign key does. The email recorded beside it
-- (created_by_email, where the table has one) keeps the audit trail readable.
-- Anything else is still refused.
--
-- Replacing two functions is backward compatible: the previous revision writes
-- nothing that either function now treats differently.

CREATE OR REPLACE FUNCTION public.theme_studio_forbid_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- jsonb, so the same function serves tables that have no created_by column
  -- (versions, events), where the condition is simply false.
  IF TG_OP = 'UPDATE'
     AND to_jsonb(OLD) ? 'created_by'
     AND to_jsonb(OLD) -> 'created_by' <> 'null'::jsonb
     AND to_jsonb(NEW) -> 'created_by' = 'null'::jsonb
     AND (to_jsonb(NEW) - 'created_by') = (to_jsonb(OLD) - 'created_by') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION '% rows are immutable', TG_TABLE_NAME;
END;
$$;

CREATE OR REPLACE FUNCTION public.theme_studio_acceptance_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'theme studio acceptance evidence is append-only';
  END IF;
  -- The operator's removal, and nothing else, may touch a finished run.
  IF OLD.created_by IS NOT NULL AND NEW.created_by IS NULL
     AND (to_jsonb(NEW) - 'created_by') = (to_jsonb(OLD) - 'created_by') THEN
    RETURN NEW;
  END IF;
  IF OLD.status NOT IN ('running', 'awaiting_browser') THEN
    RAISE EXCEPTION 'theme studio acceptance run % is final', OLD.id;
  END IF;
  IF NEW.project_id <> OLD.project_id OR NEW.version_id <> OLD.version_id
     OR NEW.package_digest <> OLD.package_digest
     OR NEW.assets_digest <> OLD.assets_digest
     OR NEW.build_id <> OLD.build_id
     OR NEW.created_by_email <> OLD.created_by_email
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'theme studio acceptance inputs are immutable';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.theme_studio_forbid_mutation() FROM PUBLIC, app_user;
REVOKE ALL ON FUNCTION public.theme_studio_acceptance_guard() FROM PUBLIC, app_user;
