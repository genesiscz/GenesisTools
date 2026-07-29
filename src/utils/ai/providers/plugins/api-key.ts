import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createGroq } from "@ai-sdk/groq";
import { createOpenAI } from "@ai-sdk/openai";
import type { AiSdkProvider } from "@genesiscz/utils/ask/types/provider";
import { getLanguageModel } from "@genesiscz/utils/ask/types/provider";
import type { SpeechModel } from "ai";
import { resolveCredential } from "../credentials";
import type { BindContext, Capability, ProviderBinding, ProviderPlugin } from "../plugin-types";
import { toSpeechModel } from "../speech-adapter";
import { speechEngineFor } from "../speech-engines";

/**
 * Metered API-key providers.
 *
 * Every factory here is called WITH an explicit apiKey. That is the whole point:
 * an argless `createOpenAI()` lets the SDK read `process.env.OPENAI_API_KEY`
 * internally, which is how keys used to arrive with nobody able to audit it.
 */

interface ApiKeyProviderSpec {
    id: string;
    envKeys: readonly string[];
    capabilities: Capability[];
    baseURL?: string;
    /**
     * `fetch` is part of this because `BindContext` promises it and something
     * already supplies it: `core/resolve.ts` forwards `opts.fetch` into the bind
     * context, and the ai-proxy plugin honours it. Every installed SDK factory
     * takes the same option, so dropping it here was the one gap that made the
     * promised transport (a proxy, tracing, an isolated test) silently not apply
     * to any API-key provider.
     */
    create: (options: {
        apiKey: string;
        baseURL?: string;
        fetch?: typeof fetch;
    }) => { languageModel: (id: string) => never } | unknown;
}

const SPECS: ApiKeyProviderSpec[] = [
    {
        id: "openai",
        envKeys: ["OPENAI_API_KEY"],
        capabilities: ["chat", "embed", "transcribe", "tts"],
        create: createOpenAI,
    },
    {
        id: "anthropic",
        envKeys: ["ANTHROPIC_API_KEY"],
        capabilities: ["chat", "summarize", "translate"],
        create: createAnthropic,
    },
    { id: "groq", envKeys: ["GROQ_API_KEY"], capabilities: ["chat", "transcribe"], create: createGroq },
    {
        id: "google",
        // GOOGLE_GENERATIVE_AI_API_KEY is what the bare @ai-sdk/google singleton
        // read. Naming it here keeps that variable working now that the singleton
        // path is gone, instead of it silently disappearing.
        envKeys: ["GOOGLE_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"],
        capabilities: ["chat", "embed"],
        create: createGoogleGenerativeAI,
    },
    {
        id: "xai",
        envKeys: ["XAI_API_KEY", "X_AI_API_KEY"],
        capabilities: ["chat", "tts", "transcribe"],
        baseURL: "https://api.x.ai/v1",
        create: createOpenAI,
    },
    {
        id: "openrouter",
        envKeys: ["OPENROUTER_API_KEY"],
        capabilities: ["chat"],
        baseURL: "https://openrouter.ai/api/v1",
        create: createOpenAI,
    },
    {
        id: "jinaai",
        envKeys: ["JINA_AI_API_KEY"],
        capabilities: ["chat", "embed", "rerank"],
        baseURL: "https://api.jina.ai/v1",
        create: createOpenAI,
    },
];

/**
 * xAI is built with `createOpenAI` pointed at `api.x.ai`, so the SDK hands it a
 * `speechModel` that would POST to `/v1/audio/speech` — an endpoint xAI does not
 * serve. Its real voice API is a different shape entirely (voice ids rather than
 * model ids, WebSocket streaming past a length limit), which is what
 * `AIXAITextToSpeechProvider` speaks. Routing `speech()` through the engine table
 * keeps the binding honest instead of exposing a method that 404s.
 */
function speechFor(
    providerId: string,
    sdkSpeechModel?: (id: string) => never
): { speech?: (modelId: string) => SpeechModel } {
    if (providerId === "xai") {
        const engine = speechEngineFor(providerId);

        if (!engine) {
            return {};
        }

        return { speech: (modelId: string) => toSpeechModel({ provider: engine, providerId, modelId }) };
    }

    return sdkSpeechModel ? { speech: (modelId: string) => sdkSpeechModel(modelId) } : {};
}

function buildPlugin(spec: ApiKeyProviderSpec): ProviderPlugin {
    return {
        id: spec.id,
        kind: "api-key",
        capabilities: new Set(spec.capabilities),
        credential: { fields: ["apiKey"], envKeys: spec.envKeys, required: ["apiKey"] },

        async bind(ctx: BindContext): Promise<ProviderBinding> {
            const { apiKey } = await resolveCredential(ctx.account, this.credential);
            if (!apiKey) {
                // resolveCredential enforces `required`, so this is unreachable;
                // it exists so the non-null assertion below is not needed.
                throw new Error(`No API key resolved for ${spec.id}`);
            }

            const provider = spec.create({
                apiKey,
                ...(spec.baseURL ? { baseURL: spec.baseURL } : {}),
                ...(ctx.fetch ? { fetch: ctx.fetch } : {}),
            }) as {
                languageModel?: (id: string) => never;
                textEmbeddingModel?: (id: string) => never;
                transcriptionModel?: (id: string) => never;
                speechModel?: (id: string) => never;
                imageModel?: (id: string) => never;
            };

            return {
                accountId: ctx.account.id,
                providerId: spec.id,
                billed: true,
                // Via `getLanguageModel`, not `provider.languageModel`: for
                // OpenAI-shaped providers the SDK's `languageModel()` defaults to
                // the Responses API, while `/v1/chat/completions` is the endpoint
                // every model here actually serves (only codex/pro need
                // Responses). Calling it directly silently moved gpt-4o traffic to
                // a different endpoint than the one ask has always used.
                language: (modelId: string) => getLanguageModel(provider as AiSdkProvider, modelId, spec.id),
                ...(provider.textEmbeddingModel
                    ? { embedding: (modelId: string) => provider.textEmbeddingModel?.(modelId) }
                    : {}),
                ...(provider.transcriptionModel
                    ? { transcription: (modelId: string) => provider.transcriptionModel?.(modelId) }
                    : {}),
                ...speechFor(spec.id, provider.speechModel),
                ...(provider.imageModel ? { image: (modelId: string) => provider.imageModel?.(modelId) } : {}),
            } as ProviderBinding;
        },
    };
}

export const apiKeyPlugins: ProviderPlugin[] = SPECS.map(buildPlugin);
