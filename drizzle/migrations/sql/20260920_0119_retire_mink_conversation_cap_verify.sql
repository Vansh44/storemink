-- The visible Mink history is still capped at ten, but conversations linked
-- to retained publication or completed-action evidence intentionally remain
-- outside that list. The physical-row cap from migration 0036 is therefore no
-- longer a valid durable invariant. This no-op migration provides an immutable
-- ledger marker for retiring that one obsolete verification query; it deletes
-- no conversation or evidence row.

SELECT 1;
