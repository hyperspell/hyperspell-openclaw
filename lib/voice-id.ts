import type { HyperspellConfig } from "../config.ts"

export interface VoiceIdResult {
  userId: string
  confidence: number
}

export interface VoiceIdentifier {
  identify(audio: Buffer | string): Promise<VoiceIdResult | null>
}

const NO_OP: VoiceIdentifier = {
  async identify() {
    return null
  },
}

const registry = new Map<string, VoiceIdentifier>()

/**
 * Register a voice-ID adapter implementation under a name that can be
 * referenced from `cfg.multiUser.scoping.voiceId.adapter`. Call this from
 * downstream code that wants to plug in a real speaker diarization model;
 * Phase 1 ships with no adapters registered — the no-op is used.
 */
export function registerVoiceIdentifier(
  name: string,
  impl: VoiceIdentifier,
): void {
  registry.set(name, impl)
}

export function getVoiceIdentifier(cfg: HyperspellConfig): VoiceIdentifier {
  const name = cfg.multiUser?.scoping?.voiceId?.adapter
  if (name && registry.has(name)) {
    return registry.get(name) as VoiceIdentifier
  }
  return NO_OP
}
