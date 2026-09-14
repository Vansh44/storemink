import "server-only";

import { sql, type SQL } from "drizzle-orm";
import { withService, type Db } from "@/lib/db/client";
import { logError } from "@/lib/observability/logger";
import { normalizeEmail } from "@/lib/email/suppression";
import {
  contactKey,
  decideRecipient,
  type AnnouncementCategory,
  type AudienceCandidate,
  type AudienceFilter,
  type SkipReason,
} from "./audience";

// ---------------------------------------------------------------------------
// Turning an audience filter into people.
//
// ── ★ ONE QUERY BUILDS THE CANDIDATE SET, `decideRecipient` JUDGES IT ──────
// The SQL narrows by things the database knows (plan, status, age, launched);
// consent, suppression and de-duplication are decided in the PURE module, so
// they are testable and so the composer's preview and the real send cannot
// disagree. Putting the consent rule in SQL would make it untestable and put
// it a `WHERE` clause away from being forgotten on the second query that needs
// it.
// ---------------------------------------------------------------------------

export interface AudiencePreview {
  /** How many people would actually be told, per channel. */
  reach: { email: number; sms: number };
  /** Everyone the filter matched, before consent and deliverability. */
  matched: number;
  /** Why the rest were dropped — the number that makes a skip actionable. */
  skipped: Record<SkipReason, number>;
  /** A handful of real recipients, so an operator can sanity-check the filter. */
  sample: { name: string; email: string | null; store: string }[];
  ok: boolean;
}

const EMPTY_SKIPS: Record<SkipReason, number> = {
  no_email: 0,
  no_phone: 0,
  suppressed: 0,
  no_consent: 0,
  duplicate: 0,
};

interface CandidateRow extends AudienceCandidate {
  storeName: string;
}

/**
 * Everyone the filter matches, with the store they belong to.
 *
 * ★ `include` DECIDES WHICH BRANCHES OF THE UNION RUN. An unrequested branch
 * is not filtered out afterwards — it is not queried — so asking for owners
 * only never loads every till operator on the platform to discard them.
 */
async function loadCandidates(
  db: Db,
  filter: AudienceFilter,
): Promise<CandidateRow[]> {
  const storeFilters: SQL[] = [];
  if (filter.plans?.length) {
    storeFilters.push(sql`s.plan = any(${sql.param(filter.plans)})`);
  }
  if (filter.statuses?.length) {
    storeFilters.push(sql`s.status = any(${sql.param(filter.statuses)})`);
  }
  if (filter.newerThanDays) {
    storeFilters.push(
      sql`s.created_at >= now() - (${filter.newerThanDays} || ' days')::interval`,
    );
  }
  if (filter.launchedOnly) {
    // Absence of the key means LAUNCHED (lib/store/launch.ts) — treating a
    // missing key as unlaunched would exclude every pre-existing store.
    storeFilters.push(
      sql`coalesce(s.settings->>'launched', 'true') <> 'false'`,
    );
  }
  if (!filter.includeDemo) {
    storeFilters.push(sql`coalesce(s.settings->>'demo', 'false') <> 'true'`);
  }

  const storeWhere = storeFilters.length
    ? sql`and ${sql.join(storeFilters, sql` and `)}`
    : sql``;

  const include = new Set(filter.include ?? ["owner"]);
  const branches: SQL[] = [];

  if (include.has("owner") || include.has("staff")) {
    // Owners and delegated staff are the same table told apart by role, so one
    // branch with a role predicate rather than two near-identical queries.
    const roleFilter = include.has("owner")
      ? include.has("staff")
        ? sql``
        : sql`and a.role = 'superadmin'`
      : sql`and a.role <> 'superadmin'`;

    branches.push(sql`
      select
        case when a.role = 'superadmin' then 'owner' else 'staff' end as kind,
        nullif(trim(coalesce(a.first_name, '') || ' ' || coalesce(a.last_name, '')), '') as name,
        a.email,
        a.phone,
        a.store_id,
        a.role,
        coalesce(a.marketing_opt_in, false) as marketing_opt_in,
        s.name as store_name
      from admins a
      join stores s on s.id = a.store_id
      where coalesce(a.is_suspended, false) = false
        ${roleFilter}
        ${storeWhere}
    `);
  }

  if (include.has("pos")) {
    branches.push(sql`
      select
        'pos' as kind,
        ps.name,
        ps.email,
        -- pos_staff has no phone column; the pure rules turn that into a
        -- no_phone skip rather than a silent omission.
        null::text as phone,
        ps.store_id,
        ps.role,
        false as marketing_opt_in,
        s.name as store_name
      from pos_staff ps
      join stores s on s.id = ps.store_id
      where ps.active = true and ps.status = 'active'
        ${storeWhere}
    `);
  }

  if (branches.length === 0) return [];

  const result = await db.execute(sql`
    ${sql.join(branches, sql` union all `)}
    order by store_name asc
    limit 50000
  `);

  return result.rows.map((r) => {
    const row = r as Record<string, unknown>;
    return {
      kind: row.kind as AudienceCandidate["kind"],
      name: typeof row.name === "string" ? row.name : "",
      email: typeof row.email === "string" ? row.email : null,
      phone: typeof row.phone === "string" ? row.phone : null,
      storeId: String(row.store_id),
      role: String(row.role ?? ""),
      marketingOptIn: row.marketing_opt_in === true,
      storeName: String(row.store_name ?? ""),
    };
  });
}

interface Judged {
  candidates: CandidateRow[];
  perChannel: Record<"email" | "sms", CandidateRow[]>;
  skipped: Record<SkipReason, number>;
}

/** Run the pure rules over a candidate set, once per channel. */
async function judge(
  db: Db,
  filter: AudienceFilter,
  category: AnnouncementCategory,
  channels: { email: boolean; sms: boolean },
): Promise<Judged> {
  const candidates = await loadCandidates(db, filter);

  // One suppression lookup for the whole run, not one per candidate.
  //
  // ⚠ Queried through the CALLER'S `db` handle rather than `findSuppressed()`,
  // which opens its own `withService`. Awaiting a second pooled connection
  // while holding the first is how a pool deadlocks under load — and this runs
  // inside the transaction that is about to write 50,000 rows.
  const addresses = [
    ...new Set(
      candidates.map((c) => normalizeEmail(c.email ?? "")).filter(Boolean),
    ),
  ];
  const suppressed = new Set<string>();
  if (channels.email && addresses.length > 0) {
    try {
      const rows = await db.execute(
        sql`select email from email_suppressions where email = any(${sql.param(addresses)})`,
      );
      for (const row of rows.rows) {
        const email = (row as { email?: unknown }).email;
        if (typeof email === "string") suppressed.add(email);
      }
    } catch (error) {
      // Fails OPEN, matching the workers: a suppression-table blip must not
      // stop an outage notice going out. The cost is mailing an address that
      // will bounce again, which the bounce webhook re-suppresses.
      logError("announcement suppression lookup failed", error);
    }
  }

  const skipped = { ...EMPTY_SKIPS };
  const perChannel: Record<"email" | "sms", CandidateRow[]> = {
    email: [],
    sms: [],
  };

  for (const channel of ["email", "sms"] as const) {
    if (!channels[channel]) continue;
    // `seen` is per channel: the same person may legitimately be both emailed
    // and texted, but never emailed twice.
    const seen = new Set<string>();
    for (const candidate of candidates) {
      const decision = decideRecipient(candidate, {
        channel,
        category,
        suppressed,
        seen,
      });
      if (!decision.send) {
        skipped[decision.reason] += 1;
        continue;
      }
      const key = contactKey(candidate, channel);
      if (key) seen.add(key);
      perChannel[channel].push(candidate);
    }
  }

  return { candidates, perChannel, skipped };
}

/**
 * What sending this would do, without sending it.
 *
 * ★ THE PREVIEW RUNS THE SAME CODE AS THE SEND. A composer that estimated its
 * reach differently from the resolver would be worse than no estimate — an
 * operator checks the number, sends, and gets a different one.
 */
export async function previewAudience(
  filter: AudienceFilter,
  category: AnnouncementCategory,
  channels: { email: boolean; sms: boolean },
): Promise<AudiencePreview> {
  try {
    return await withService(async (db) => {
      const { candidates, perChannel, skipped } = await judge(
        db,
        filter,
        category,
        channels,
      );

      return {
        reach: {
          email: perChannel.email.length,
          sms: perChannel.sms.length,
        },
        matched: candidates.length,
        skipped,
        sample: perChannel.email.slice(0, 5).map((c) => ({
          name: c.name || c.email || "",
          email: c.email,
          store: c.storeName,
        })),
        ok: true,
      };
    });
  } catch (error) {
    logError("previewAudience failed", error);
    return {
      reach: { email: 0, sms: 0 },
      matched: 0,
      skipped: { ...EMPTY_SKIPS },
      sample: [],
      ok: false,
    };
  }
}

export interface MaterialiseResult {
  total: number;
  skipped: number;
  error?: string;
}

/**
 * Write one recipient row per person per channel, then mark the announcement
 * `sending` so the worker will pick it up.
 *
 * ★ THE STATUS FLIP IS LAST, AND IN THE SAME TRANSACTION. `claim_announcement_batch`
 * only claims rows whose announcement is `sending`, so a crash midway through
 * writing recipients leaves an announcement that is still a draft with some
 * rows attached — recoverable and, crucially, not half-sent. Flipping first
 * would let the worker start mailing a partially-resolved audience.
 *
 * ★ AND IT IS `ON CONFLICT DO NOTHING`. The unique indexes make a
 * double-submitted resolve a no-op rather than a second copy of the message to
 * every merchant on the platform.
 */
export async function materialiseRecipients(
  announcementId: string,
  filter: AudienceFilter,
  category: AnnouncementCategory,
  channels: { email: boolean; sms: boolean },
): Promise<MaterialiseResult> {
  try {
    return await withService(async (db) => {
      const { perChannel, skipped } = await judge(
        db,
        filter,
        category,
        channels,
      );

      const rows: {
        channel: "email" | "sms";
        candidate: CandidateRow;
      }[] = [];
      for (const channel of ["email", "sms"] as const) {
        for (const candidate of perChannel[channel]) {
          rows.push({ channel, candidate });
        }
      }

      if (rows.length === 0) {
        return {
          total: 0,
          skipped: Object.values(skipped).reduce((a, b) => a + b, 0),
          error: "Nobody matches this audience.",
        };
      }

      // Chunked: a single INSERT with 50,000 VALUES tuples exceeds the
      // parameter limit long before it exceeds anything else.
      const CHUNK = 500;
      for (let i = 0; i < rows.length; i += CHUNK) {
        const chunk = rows.slice(i, i + CHUNK);
        const values = chunk.map(
          ({ channel, candidate }) => sql`(
            ${announcementId}::uuid,
            ${channel},
            ${channel === "email" ? normalizeEmail(candidate.email ?? "") : null},
            ${channel === "sms" ? candidate.phone : null},
            ${candidate.name},
            ${candidate.storeId}::uuid,
            ${candidate.kind},
            ${candidate.role}
          )`,
        );
        await db.execute(sql`
          insert into platform_announcement_recipients
            (announcement_id, channel, email, phone, name, store_id, person_kind, role)
          values ${sql.join(values, sql`, `)}
          on conflict do nothing
        `);
      }

      const skippedTotal = Object.values(skipped).reduce((a, b) => a + b, 0);

      await db.execute(sql`
        update platform_announcements
           set status = 'sending',
               total = ${rows.length},
               skipped = ${skippedTotal},
               updated_at = now()
         where id = ${announcementId}::uuid
           and status = 'draft'
      `);

      return { total: rows.length, skipped: skippedTotal };
    });
  } catch (error) {
    logError("materialiseRecipients failed", error, { announcementId });
    return { total: 0, skipped: 0, error: "Couldn't resolve the audience." };
  }
}
