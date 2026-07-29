import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createGroq } from "@ai-sdk/groq";
import { createOpenAI } from "@ai-sdk/openai";
import { resolveCredential } from "../credentials";
import type { BindContext, Capability, ProviderBinding, ProviderPlugin } from "../plugin-types";

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
    create: (options: { apiKey: string; baseURL?: string }) => { languageModel: (id: string) => never } | unknown;
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
];

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

            const provider = spec.create({ apiKey, ...(spec.baseURL ? { baseURL: spec.baseURL } : {}) }) as {
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
                language: (modelId: string) => {
                    if (!provider.languageModel) {
                        throw new Error(`${spec.id} exposes no language model`);
                    }

                    return provider.languageModel(modelId);
                },
                ...(provider.textEmbeddingModel
                    ? { embedding: (modelId: string) => provider.textEmbeddingModel?.(modelId) }
                    : {}),
                ...(provider.transcriptionModel
                    ? { transcription: (modelId: string) => provider.transcriptionModel?.(modelId) }
                    : {}),
                ...(provider.speechModel ? { speech: (modelId: string) => provider.speechModel?.(modelId) } : {}),
                ...(provider.imageModel ? { image: (modelId: string) => provider.imageModel?.(modelId) } : {}),
            } as ProviderBinding;
        },
    };
}

export const apiKeyPlugins: ProviderPlugin[] = SPECS.map(buildPlugin);
