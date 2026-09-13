export const MINK_VOICE_PROVIDERS = ["chirp_3", "saaras_v4"] as const;

export type MinkVoiceProvider = (typeof MINK_VOICE_PROVIDERS)[number];

export const DEFAULT_MINK_VOICE_PROVIDER: MinkVoiceProvider = "chirp_3";

export function isMinkVoiceProvider(
  value: unknown,
): value is MinkVoiceProvider {
  return (
    typeof value === "string" &&
    (MINK_VOICE_PROVIDERS as readonly string[]).includes(value)
  );
}
