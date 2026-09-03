import { Synthesizer } from "@genesiscz/utils/ai/tasks/Synthesizer";
import type { TTSVoice } from "@genesiscz/utils/ai/types";
import { logger } from "@genesiscz/utils/logger";

export interface SayVoiceProvider {
    /** `tools say --provider` value: macos, openai, xai, … */
    id: string;
    label: string;
    voices: TTSVoice[];
}

const LABELS: Record<string, string> = { macos: "macOS", openai: "OpenAI", xai: "xAI" };
const CACHE_TTL_MS = 5 * 60 * 1000;

let cache: { at: number; providers: SayVoiceProvider[] } | null = null;

/**
 * Voices `tools say` can use right now, grouped by provider. A provider only
 * appears when its engine reports itself available (macOS always; xAI and
 * OpenAI once an account or key exists), so the picker shows what will work.
 */
export async function listSayVoices(opts: { fresh?: boolean } = {}): Promise<SayVoiceProvider[]> {
    if (!opts.fresh && cache && Date.now() - cache.at < CACHE_TTL_MS) {
        return cache.providers;
    }

    const synthesizer = await Synthesizer.create({ provider: "any" });
    const grouped = await synthesizer.listVoices();
    const providers = Object.entries(grouped)
        .map(([id, voices]) => ({ id, label: LABELS[id] ?? id, voices }))
        .sort((a, b) => a.label.localeCompare(b.label));

    logger.debug({ providers: providers.map((p) => `${p.id}:${p.voices.length}`) }, "monitor: say voices listed");
    cache = { at: Date.now(), providers };

    return providers;
}
