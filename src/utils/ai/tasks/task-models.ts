import { byTaskAndProvider } from "../local/descriptors";
import type { Capability } from "../providers/plugin-types";

/**
 * The model a provider uses for a task when nobody named one.
 *
 * These ids deliberately do NOT live in `catalog/static.ts`. That list is the
 * CHAT registry: `ask` renders `byProvider(name)` verbatim as its model picker
 * (src/ask/providers/ProviderManager.ts:471), so a `whisper-1` row there would
 * be offered as something a user could hold a conversation with. Keeping the
 * speech ids here means `resolveModel` still answers "which model" for an ASR
 * call without polluting the chat list — it reaches this table through
 * `ResolveOptions.fallbackModelId`, after the catalog and before the error.
 *
 * Every value is the id the pre-facade code already hardcoded, so the facade
 * picks the same model the old path did:
 *   - ASR: `TranscriptionManager.getDefaultModelForProvider` (transcription/TranscriptionManager.ts:583)
 *   - OpenAI TTS: `resolveModel()` in providers/openai/AIOpenAITextToSpeechProvider.ts:60-61
 *   - cloud embeddings: `AICloudProvider.embedBatch` (providers/AICloudProvider.ts:211)
 * Local runtimes answer from the descriptor catalogue instead (see `localDefault`).
 */
const STATIC_TASK_MODELS: Record<string, Partial<Record<Capability, string>>> = {
    openai: { transcribe: "whisper-1", tts: "tts-1", embed: "text-embedding-3-small" },
    groq: { transcribe: "whisper-large-v3" },
    openrouter: { transcribe: "openai/whisper-1" },
    // xAI's TTS is voice-addressed rather than model-addressed (the REST body
    // carries `voice_id`, providers/xai/AIXAITextToSpeechProvider.ts:98), so the
    // id here only names the product for logs and cache keys.
    xai: { tts: "xai-tts", transcribe: "xai-stt" },
    deepgram: { transcribe: "nova-3" },
    assemblyai: { transcribe: "best" },
    gladia: { transcribe: "default" },
    google: { embed: "text-embedding-004" },
    // `say` has one engine; the voice is an option, not a model.
    macos: { tts: "system" },
    // Not the descriptor list's head (that is the English-only distil model):
    // this is the id `AILocalProvider.transcribe` itself falls back to
    // (providers/AILocalProvider.ts:101), chosen there because whisper-small was
    // producing garbage for Czech.
    "local-hf": { transcribe: "onnx-community/whisper-large-v3-turbo" },
};

/** Local runtimes keep their model list in the descriptor catalogue, not the static one. */
const LOCAL_PROVIDERS = ["local-hf", "ollama", "coreml", "darwinkit"] as const;

function localDefault(providerId: string, capability: Capability): string | undefined {
    if (!(LOCAL_PROVIDERS as readonly string[]).includes(providerId)) {
        return undefined;
    }

    if (capability !== "embed" && capability !== "transcribe") {
        return undefined;
    }

    return byTaskAndProvider(capability, providerId)[0]?.id;
}

/**
 * Default model id for a provider/capability pair, or undefined when the pair is
 * not something that provider does.
 */
export function taskModelDefault(providerId: string, capability: Capability): string | undefined {
    return STATIC_TASK_MODELS[providerId]?.[capability] ?? localDefault(providerId, capability);
}

/**
 * A CLI's `--provider` / `--model` pair as one ModelRef.
 *
 * The pair does not map onto the ref grammar directly: there is no
 * "provider, no model" form (core/model-ref.ts:48-53), so a lone `deepgram`
 * parses as a BARE MODEL ID called "deepgram" and the request goes out asking
 * Deepgram for a model of that name. Filling the model half from this table is
 * what `--provider deepgram` has always meant — the same default
 * `TranscriptionManager.getDefaultModelForProvider` picked.
 */
export function taskModelRef(
    options: { provider?: string; model?: string } | undefined,
    capability: Capability
): string | undefined {
    const { provider, model } = options ?? {};

    if (provider && model) {
        return `${provider}/${model}`;
    }

    if (provider) {
        const fallback = taskModelDefault(provider, capability);
        return fallback ? `${provider}/${fallback}` : provider;
    }

    return model;
}

/** Providers this table can name a model for — the input to availability fallback. */
export function providersWithTaskModel(capability: Capability): string[] {
    const ids = new Set<string>();

    for (const id of Object.keys(STATIC_TASK_MODELS)) {
        if (STATIC_TASK_MODELS[id]?.[capability]) {
            ids.add(id);
        }
    }

    for (const id of LOCAL_PROVIDERS) {
        if (localDefault(id, capability)) {
            ids.add(id);
        }
    }

    return [...ids];
}
