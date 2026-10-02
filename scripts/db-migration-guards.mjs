/** Known historical compatibility repair. Run inside the migration transaction,
 * after its lock timeout is set. Do not change applied SQL or ledger checksums. */
export async function guardLegacyImageRetries(client, migrationId) {
  const initial =
    migrationId === "20261002_0147_theme_studio_image_checkpoints";
  const safety = migrationId === "20261002_0150_theme_studio_recovery_safety";
  if (!initial && !safety) return;
  // Freeze claims, queue inserts and settlement until this transaction commits.
  // With no unfinished image rows, 0147 cannot enable an old worker's reclaim.
  await client.query(
    "lock table public.theme_studio_runs in share row exclusive mode",
  );
  const { rows } = await client.query(
    initial
      ? "select count(*)::int as unfinished from public.theme_studio_runs where kind='images' and status in ('queued','running')"
      : "select count(*)::int as unfinished from public.theme_studio_runs r where kind='images' and status in ('queued','running') and attempt_count>1 and not exists(select 1 from public.theme_studio_image_checkpoints c where c.run_id=r.id)",
  );
  if (rows[0].unfinished > 0) {
    throw new Error(
      initial
        ? "Checkpoint upgrade refused: drain or cancel unfinished image runs before applying 0147; old workers cannot safely replay paid artwork. No image retry allowance was changed."
        : "Recovery safety upgrade refused: drain or cancel legacy image runs with multiple claims and no checkpoints before applying 0150. Their retry allowance cannot safely be reduced below existing claims.",
    );
  }
}
