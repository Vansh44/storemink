import "server-only";

import { eq } from "drizzle-orm";
import { platformAdmins } from "@/drizzle/schema";
import { getServerUser } from "@/lib/auth/server-user";
import { withService } from "@/lib/db/client";

// ---------------------------------------------------------------------------
// The Theme Studio authority check — superadmin only, for EVERY read and write.
//
// ★ Not `getPlatformViewer()`. That returns an email and a role, and Studio
// records its actor in uuid columns that reference platform_admins.id, so it
// needs the row id too. Resolving it here, from the verified session email,
// means no caller can ever supply an actor id: the only path to one is the
// session.
//
// ★ A platform MEMBER is refused. Phase 0 decided Studio prompts, references,
// candidates and model choices are superadmin data, not merely superadmin
// writes; there is no read-only member view of a project.
//
// ★ It fails CLOSED. An unreadable platform_admins row is "not authorized",
// never "authorized" — every read behind this gate runs under service scope,
// which bypasses RLS, so this is the whole of the access control.
// ---------------------------------------------------------------------------

export interface ThemeStudioActor {
  /** platform_admins.id */
  id: string;
  email: string;
}

export async function getThemeStudioActor(): Promise<ThemeStudioActor | null> {
  const user = await getServerUser();
  const email = user?.email?.trim().toLowerCase();
  if (!email) return null;
  try {
    const rows = await withService((db) =>
      db
        .select({
          id: platformAdmins.id,
          email: platformAdmins.email,
          role: platformAdmins.role,
        })
        .from(platformAdmins)
        .where(eq(platformAdmins.email, email))
        .limit(1),
    );
    const row = rows[0];
    if (!row || row.role !== "superadmin") return null;
    return { id: row.id, email: row.email };
  } catch {
    return null;
  }
}
