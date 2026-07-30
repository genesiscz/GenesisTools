import type { AITask } from "@genesiscz/utils/config/ai.types";
import type { ModelEntry } from "../../types";
import { EMBED_MODELS, SUMMARIZE_MODELS, TRANSCRIBE_MODELS, TRANSLATE_MODELS, TTS_MODELS } from "./models";
import type { ArtifactRef, LocalModelDescriptor, LocalRuntimeId } from "./types";

export type { ArtifactRef, LocalModelDescriptor, LocalRuntimeId } from "./types";

/**
 * Which runtime executes a model is a function of its provider today: every
 * `local-hf` entry runs through transformers.js, `coreml`/`darwinkit` go to the
 * DarwinKit Swift binary, `ollama` talks to the daemon, and hosted providers
 * have no local runtime at all. Deriving it here keeps the catalogue in
 * `models.ts` a pure data move — a descriptor that needs to disagree (the
 * sherpa diarization models) declares its runtime explicitly.
 */
const RUNTIME_BY_PROVIDER: Partial<Record<ModelEntry["provider"], LocalRuntimeId>> = {
    "local-hf": "transformers-js",
    coreml: "coreml",
    darwinkit: "darwinkit",
    ollama: "ollama",
};

function artifactsFor(entry: ModelEntry): ArtifactRef[] {
    // Only transformers.js models have weights this repo is responsible for
    // fetching. OS built-ins ship with macOS, ollama pulls its own, hosted APIs
    // have none.
    if (entry.provider === "local-hf") {
        return [{ source: "hf", locator: entry.id }];
    }

    return [];
}

function toDescriptor(entry: ModelEntry, meta?: Record<string, unknown>): LocalModelDescriptor {
    const runtime = RUNTIME_BY_PROVIDER[entry.provider];

    return {
        ...entry,
        ...(runtime ? { runtime } : {}),
        artifacts: artifactsFor(entry),
        ...(meta ? { meta } : {}),
    };
}

/**
 * The whole catalogue, task-tagged, in registration order. TTS entries are
 * tagged `meta.orphaned` because no task facade asks for them yet — they stay
 * in the array on purpose, since `findDescriptor`/`byTaskAndProvider` have
 * always returned them.
 */
export const LOCAL_MODELS: ReadonlyArray<LocalModelDescriptor> = [
    ...EMBED_MODELS.map((m) => toDescriptor(m)),
    ...TRANSCRIBE_MODELS.map((m) => toDescriptor(m)),
    ...TRANSLATE_MODELS.map((m) => toDescriptor(m)),
    ...SUMMARIZE_MODELS.map((m) => toDescriptor(m)),
    ...TTS_MODELS.map((m) => toDescriptor(m, { orphaned: true })),
];

const modelById = new Map<string, LocalModelDescriptor>(LOCAL_MODELS.map((m) => [m.id, m]));

const DEFAULT_CONTEXT_LENGTH = 512;
const DEFAULT_CHARS_PER_TOKEN = 3;

/**
 * Fallback context lengths for models NOT in the registry.
 * Models already in the registry have contextLength on their entry.
 */
const FALLBACK_CONTEXT_LENGTHS: Record<string, number> = {
    "snowflake-arctic-embed": 512,
    "text-embedding-3-large": 8191,
    "text-embedding-ada-002": 8191,
};

/**
 * Fallback task prefixes for models NOT in the registry.
 * Models already in the registry have taskPrefix on their entry.
 */
const FALLBACK_TASK_PREFIXES: Record<string, { document: string; query: string }> = {
    "nomic-embed-code": { document: "search_document: ", query: "search_query: " },
};

const GPU_ORDER: Record<ModelEntry["provider"], number> = {
    ollama: 0,
    coreml: 1,
    "local-hf": 2,
    darwinkit: 3,
    cloud: 4,
    google: 5,
    openai: 6,
    groq: 7,
    openrouter: 8,
};

export function byTask(task: AITask): ReadonlyArray<LocalModelDescriptor> {
    return LOCAL_MODELS.filter((m) => m.task === task);
}

export function byTaskAndProvider(task: AITask, provider: string): ReadonlyArray<LocalModelDescriptor> {
    return LOCAL_MODELS.filter((m) => m.task === task && m.provider === provider);
}

/** All distinct provider types that have embedding models registered. */
export function embeddingProviderTypes(): ReadonlySet<ModelEntry["provider"]> {
    const types = new Set<ModelEntry["provider"]>();

    for (const m of LOCAL_MODELS) {
        if (m.task === "embed") {
            types.add(m.provider);
        }
    }

    return types;
}

export function findDescriptor(id: string): LocalModelDescriptor | undefined {
    return modelById.get(id) ?? modelById.get(id.replace(/:.*$/, ""));
}

export function maxEmbedChars(modelId: string): number {
    const baseId = modelId.replace(/:.*$/, "");
    const registered = modelById.get(modelId) ?? modelById.get(baseId);

    if (registered?.contextLength) {
        const cpt = registered.charsPerToken ?? DEFAULT_CHARS_PER_TOKEN;
        return registered.contextLength * cpt;
    }

    const contextLength = FALLBACK_CONTEXT_LENGTHS[baseId] ?? FALLBACK_CONTEXT_LENGTHS[modelId];

    if (contextLength) {
        return contextLength * DEFAULT_CHARS_PER_TOKEN;
    }

    return DEFAULT_CONTEXT_LENGTH * DEFAULT_CHARS_PER_TOKEN;
}

export function taskPrefix(modelId: string): { document: string; query: string } | null {
    const baseId = modelId.replace(/:.*$/, "");
    const registered = modelById.get(modelId) ?? modelById.get(baseId);

    if (registered?.taskPrefix) {
        return registered.taskPrefix;
    }

    return FALLBACK_TASK_PREFIXES[baseId] ?? FALLBACK_TASK_PREFIXES[modelId] ?? null;
}

export function embedModelsForType(type: "code" | "files" | "mail" | "chat"): ReadonlyArray<LocalModelDescriptor> {
    const category = type === "code" || type === "files" ? "code" : type === "mail" ? "mail" : "general";

    return [...byTask("embed")].sort((a, b) => {
        const aMatch = a.bestFor?.includes(category) ? 0 : 1;
        const bMatch = b.bestFor?.includes(category) ? 0 : 1;

        if (aMatch !== bMatch) {
            return aMatch - bMatch;
        }

        return GPU_ORDER[a.provider] - GPU_ORDER[b.provider];
    });
}
