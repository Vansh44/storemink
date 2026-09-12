import "server-only";

import { sql } from "drizzle-orm";
import { withService } from "@/lib/db/client";
import { logError, logInfo } from "@/lib/observability/logger";
import { sendEmail } from "@/lib/email/send";
import { renderAnnouncementEmail } from "@/lib/email/announcement-email";
import { PLATFORM_EMAIL_DOMAIN } from "@/lib/email/sender";
import type { StoreBrand } from "@/lib/store/brand";
import { PLATFORM_URL } from "@/lib/site";

// ---------------------------------------------------------------------------
// Draining the announcement queue.
//
// ── ★ IT RIDES THE EXISTING EMAIL HEARTBEAT ────────────────────────────────
// `/api/cron/send-emails` already drains two email queues and the SMS queue;
// this is a fourth. §37's reason, restated: a separate Cloud Scheduler entry is
// one more thing to create and one more thing to forget, and
// `docs/cron-jobs.md` records that happening three times already.
//
// ── ★ EVERY MESSAGE LEAVES THROUGH `sendEmail` ─────────────────────────────
// The choke point (§24), so every announcement lands in `email_logs` with the
// `announcement` mailer — which is what makes "did this merchant get the
// pricing notice?" answerable at all. `send-coverage.test.ts` enforces it.
//
// ── ★ SINGLE SENDS, NOT A BATCH ────────────────────────────────────────────
// The coupon worker batches through Resend because it sends one identical body
// to thousands. So does this — but the per-recipient row is the auditable
// record, and `sendEmailBatch` reports per-message outcomes that would then
// have to be mapped back onto rows by index. At announcement volumes
// (hundreds, not hundreds of thousands) the simpler path is worth more than
// the round trips, and it is the path that keeps one bad address from
// obscuring which row failed.
// ---------------------------------------------------------------------------

const BATCH = 50;
const MAX_PER_RUN = 500;

const ANNOUNCEMENT_FROM = `StoreMink <hello@${PLATFORM_EMAIL_DOMAIN}>`;

const PLATFORM_BRAND: StoreBrand = {
  name: "StoreMink",
  logoUrl: null,
  primaryColor: "#202223",
  tagline: null,
  blurb: null,
  legalName: "StoreMink",
  creditLine: null,
  email: null,
  phone: null,
  hours: null,
  social: { instagram: null, youtube: null, whatsapp: null },
  badges: [],
  domain: PLATFORM_EMAIL_DOMAIN,
};

export interface AnnouncementWorkerResult {
  processed: number;
  sent: number;
  failed: number;
  /** Pending email rows left across every sending announcement. */
  remaining: number;
}

interface RecipientRow {
  id: string;
  announcement_id: string;
  email: string | null;
  name: string | null;
}

interface AnnouncementRow {
  id: string;
  subject: string;
  body: string;
  cta_label: string | null;
  cta_url: string | null;
  category: "feature" | "operational";
}

export async function processAnnouncements(
  maxPerRun = MAX_PER_RUN,
): Promise<AnnouncementWorkerResult> {
  let processed = 0;
  let sent = 0;
  let failed = 0;

  // Recover rows a crashed run left mid-flight, exactly as the campaign worker
  // does. Without it a killed worker strands an announcement at 60% forever.
  await withService((db) =>
    db.execute(
      sql`select requeue_stale_announcement_recipients(p_older_than_seconds => ${600})`,
    ),
  ).catch((err) => logError("requeue_stale_announcement_recipients", err));

  while (processed < maxPerRun) {
    const want = Math.min(BATCH, maxPerRun - processed);

    let batch: RecipientRow[] = [];
    try {
      const res = await withService((db) =>
        db.execute(
          sql`select id, announcement_id, email, name
                from claim_announcement_batch(p_channel => 'email', p_limit => ${want})`,
        ),
      );
      batch = res.rows as unknown as RecipientRow[];
    } catch (err) {
      logError("claim_announcement_batch failed", err);
      break;
    }
    if (batch.length === 0) break;

    // One copy read per announcement in the batch, never per recipient.
    const ids = [...new Set(batch.map((r) => r.announcement_id))];
    const copyById = new Map<string, AnnouncementRow>();
    try {
      const res = await withService((db) =>
        db.execute(
          sql`select id, subject, body, cta_label, cta_url, category
                from platform_announcements where id = any(${sql.param(ids)}::uuid[])`,
        ),
      );
      for (const row of res.rows as unknown as AnnouncementRow[]) {
        copyById.set(row.id, row);
      }
    } catch (err) {
      logError("announcement copy read failed", err);
      break;
    }

    for (const recipient of batch) {
      processed += 1;
      const copy = copyById.get(recipient.announcement_id);

      if (!copy || !recipient.email) {
        failed += 1;
        await markRecipient(recipient.id, "failed", "Missing copy or address.");
        continue;
      }

      const { subject, html } = renderAnnouncementEmail({
        brand: PLATFORM_BRAND,
        subject: copy.subject,
        bodyHtml: copy.body,
        ctaLabel: copy.cta_label,
        ctaUrl: copy.cta_url,
        category: copy.category,
        preferencesUrl: `${PLATFORM_URL}/dashboard/settings/account`,
        recipientName: recipient.name,
      });

      const result = await sendEmail({
        storeId: null, // Platform mail: it is StoreMink writing, not a store.
        to: recipient.email,
        from: ANNOUNCEMENT_FROM,
        subject,
        html,
        mailer: "announcement",
      });

      if (result.sent) {
        sent += 1;
        await markRecipient(recipient.id, "sent");
      } else if (result.skipped) {
        // A suppressed address is a decision, not a failure — `sendEmail`
        // already declined it and logged why.
        await markRecipient(recipient.id, "skipped", result.error);
      } else {
        failed += 1;
        await markRecipient(recipient.id, "failed", result.error);
      }
    }

    await refreshCounts(ids);
  }

  const remaining = await pendingCount();
  if (processed > 0) {
    logInfo("announcement worker run", { processed, sent, failed, remaining });
  }
  return { processed, sent, failed, remaining };
}

async function markRecipient(
  id: string,
  status: "sent" | "failed" | "skipped",
  error?: string | null,
): Promise<void> {
  await withService((db) =>
    db.execute(sql`
      update platform_announcement_recipients
         set status = ${status},
             error = ${error ?? null},
             sent_at = case when ${status} = 'sent' then now() else sent_at end
       where id = ${id}::uuid
    `),
  ).catch((err) => logError("markRecipient failed", err, { id, status }));
}

/**
 * Roll per-recipient outcomes up onto the announcement, and finish it when
 * nothing is pending.
 *
 * ★ `partial` IS A REAL OUTCOME, NOT A FAILURE. Some recipients bounced and
 * the rest were told; calling that "failed" invites an operator to send the
 * whole thing again, which double-mails everyone it reached.
 */
async function refreshCounts(announcementIds: string[]): Promise<void> {
  if (announcementIds.length === 0) return;
  await withService((db) =>
    db.execute(sql`
      update platform_announcements a
         set sent    = c.sent,
             failed  = c.failed,
             skipped = c.skipped,
             status  = case
                         when c.pending > 0 then 'sending'
                         when c.sent = 0 and c.failed > 0 then 'failed'
                         when c.failed > 0 or c.skipped > 0 then 'partial'
                         else 'sent'
                       end,
             sent_at = case when c.pending = 0 then coalesce(a.sent_at, now())
                            else a.sent_at end,
             updated_at = now()
        from (
          select announcement_id,
                 count(*) filter (where status = 'sent')::int    as sent,
                 count(*) filter (where status = 'failed')::int  as failed,
                 count(*) filter (where status = 'skipped')::int as skipped,
                 count(*) filter (where status in ('pending','sending'))::int as pending
            from platform_announcement_recipients
           where announcement_id = any(${sql.param(announcementIds)}::uuid[])
           group by announcement_id
        ) c
       where a.id = c.announcement_id
    `),
  ).catch((err) => logError("refreshCounts failed", err));
}

async function pendingCount(): Promise<number> {
  try {
    const res = await withService((db) =>
      db.execute(sql`
        select count(*)::int as n
          from platform_announcement_recipients r
          join platform_announcements a on a.id = r.announcement_id
         where r.status = 'pending' and r.channel = 'email'
           and a.status = 'sending'
      `),
    );
    const row = res.rows[0] as { n?: unknown } | undefined;
    return Number(row?.n) || 0;
  } catch {
    // A count failure must not look like "nothing left" — but it also must not
    // throw into the cron. Reporting 0 only costs the self-chain, and the next
    // heartbeat picks the work up.
    return 0;
  }
}
