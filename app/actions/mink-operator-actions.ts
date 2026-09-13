"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { getPlatformViewer } from "@/app/actions/platform";
import {
  minkActionToolAccess,
  minkStoreAccess,
  minkVoiceSettings,
  stores,
} from "@/drizzle/schema";
import { withService } from "@/lib/db/client";
import { MINK_ACTION_TOOLS } from "@/lib/mink/product-action-types";
import { logError, logInfo } from "@/lib/observability/logger";
import {
  isMinkVoiceProvider,
  type MinkVoiceProvider,
} from "@/lib/mink/voice-provider";

export async function setMinkVoiceProvider(
  provider: unknown,
): Promise<{ success?: true; provider?: MinkVoiceProvider; error?: string }> {
  const viewer = await getPlatformViewer();
  if (viewer?.role !== "superadmin")
    return { error: "Only a platform superadmin can change the voice model." };
  if (!isMinkVoiceProvider(provider))
    return { error: "Choose Google Chirp 3 or Sarvam Saaras v4." };
  try {
    const now = new Date().toISOString();
    await withService((db) =>
      db
        .insert(minkVoiceSettings)
        .values({
          id: true,
          provider,
          updatedAt: now,
          updatedBy: viewer.email,
        })
        .onConflictDoUpdate({
          target: minkVoiceSettings.id,
          set: { provider, updatedAt: now, updatedBy: viewer.email },
        }),
    );
    revalidatePath("/platform/dashboard/(console)/mink", "page");
    logInfo("mink.voice.settings.changed", {
      provider,
      operator: viewer.email,
    });
    return { success: true, provider };
  } catch (error) {
    logError("mink.voice.settings.change_failed", error, { provider });
    return { error: "Could not change the voice model. Try again." };
  }
}

/** One store-level switch. Staff permissions and exact-action approvals are independent. */
export async function setMinkBetaAccess(
  storeId: string,
  enabled: boolean,
): Promise<{ success?: true; error?: string }> {
  const viewer = await getPlatformViewer();
  if (viewer?.role !== "superadmin")
    return { error: "Only a platform superadmin can change Mink AI access." };
  if (
    typeof enabled !== "boolean" ||
    typeof storeId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      storeId,
    )
  )
    return { error: "Invalid Mink AI state or store." };
  try {
    const changed = await withService(async (db) => {
      const store = await db
        .select({ id: stores.id })
        .from(stores)
        .where(eq(stores.id, storeId))
        .limit(1);
      if (!store[0]) return false;
      const now = new Date().toISOString();
      // Upsert serializes even first-time concurrent enable/disable. Always
      // lock the parent before children, in the same withService transaction.
      const access = {
        enabled,
        draftingEnabled: enabled,
        phase: "merchant_beta",
        invitedBy: enabled ? viewer.email : null,
        invitedAt: enabled ? now : null,
        updatedAt: now,
      };
      await db
        .insert(minkStoreAccess)
        .values({ storeId, ...access })
        .onConflictDoUpdate({ target: minkStoreAccess.storeId, set: access });
      if (enabled) {
        await db
          .insert(minkActionToolAccess)
          .values(
            MINK_ACTION_TOOLS.map((toolName) => ({
              storeId,
              toolName,
              enabled: true,
              enabledBy: viewer.email,
              enabledAt: now,
              updatedAt: now,
            })),
          )
          .onConflictDoUpdate({
            target: [
              minkActionToolAccess.storeId,
              minkActionToolAccess.toolName,
            ],
            set: {
              enabled: true,
              enabledBy: viewer.email,
              enabledAt: now,
              updatedAt: now,
            },
          });
      } else {
        await db
          .update(minkActionToolAccess)
          .set({
            enabled: false,
            enabledBy: null,
            enabledAt: null,
            updatedAt: now,
          })
          .where(eq(minkActionToolAccess.storeId, storeId));
      }
      return true;
    });
    if (!changed) return { error: "Store not found." };
    revalidatePath(`/dashboard/stores/${storeId}`);
    revalidatePath("/dashboard/mink");
    logInfo("mink.access: changed", {
      storeId,
      enabled,
      operator: viewer.email,
    });
    return { success: true };
  } catch (error) {
    logError("mink.access: failed", error, { storeId, enabled });
    return { error: "Could not change Mink AI access. Try again." };
  }
}
