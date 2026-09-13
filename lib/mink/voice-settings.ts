import "server-only";

import { eq } from "drizzle-orm";
import { minkVoiceSettings } from "@/drizzle/schema";
import { withService } from "@/lib/db/client";
import {
  DEFAULT_MINK_VOICE_PROVIDER,
  isMinkVoiceProvider,
  type MinkVoiceProvider,
} from "./voice-provider";

/** Resolve the single platform-wide voice model. */
export async function getMinkVoiceProvider(): Promise<MinkVoiceProvider> {
  const [row] = await withService((db) =>
    db
      .select({ provider: minkVoiceSettings.provider })
      .from(minkVoiceSettings)
      .where(eq(minkVoiceSettings.id, true))
      .limit(1),
  );
  return isMinkVoiceProvider(row?.provider)
    ? row.provider
    : DEFAULT_MINK_VOICE_PROVIDER;
}
