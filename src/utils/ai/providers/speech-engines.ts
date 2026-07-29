import type { AITextToSpeechProvider } from "../types";
import { AIMacOSTextToSpeechProvider } from "./AIMacOSTextToSpeechProvider";
import { AIOpenAITextToSpeechProvider } from "./openai/AIOpenAITextToSpeechProvider";
import { AIXAITextToSpeechProvider } from "./xai/AIXAITextToSpeechProvider";

/**
 * Plugin id → the full-fat TTS engine behind it.
 *
 * The other three tasks reach their provider through the binding alone, because
 * an embedding or a transcript is fully described by the ai-sdk shape. Speech is
 * not: `SpeechModelV3` is text-in/audio-out, and the three things that decide
 * how `tools say` actually sounds live outside it —
 *
 *   - macOS `speak()` pipes to the speakers with the `[[volm]]` directive, so
 *     `--volume` costs no temp file (providers/AIMacOSTextToSpeechProvider.ts:31);
 *   - xAI streams over WebSocket for anything past the REST length limit;
 *   - each cloud voice needs a loudness offset to match native `say` at the same
 *     `--volume` (providers/xai/AIXAITextToSpeechProvider.ts:51).
 *
 * Squeezing those through `speech()` would mean deleting them. So the binding
 * still exposes `speech()` for byte-level consumers (via `toSpeechModel`), and
 * `Synthesizer` — the engine that owns rate, volume, streaming and playback —
 * reaches the rich provider through this table. The two agree on WHO because
 * both are keyed by the plugin id the resolution ladder chose.
 *
 * This table is the seam that dies in Phase 10 with the rest of the legacy
 * provider classes; until then it is the honest way to keep the behaviour.
 */
const ENGINES: Record<string, () => AITextToSpeechProvider> = {
    macos: () => new AIMacOSTextToSpeechProvider(),
    xai: () => new AIXAITextToSpeechProvider(),
    openai: () => new AIOpenAITextToSpeechProvider(),
};

/** The engine for a plugin id, or undefined when that provider does not speak. */
export function speechEngineFor(providerId: string): AITextToSpeechProvider | undefined {
    return ENGINES[providerId]?.();
}

/** Plugin ids this table can build an engine for. */
export function speechEngineIds(): string[] {
    return Object.keys(ENGINES);
}
