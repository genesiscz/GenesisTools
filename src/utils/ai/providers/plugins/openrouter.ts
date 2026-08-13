import { createOpenAI } from "@ai-sdk/openai";
import { logger } from "@genesiscz/utils/logger";
import { createOpenRouter, type OpenRouterChatSettings } from "@openrouter/ai-sdk-provider";
import { z } from "zod";
import type { AccountEntry } from "../../config/schema";
import { resolveCredential } from "../credentials";
import type { BindContext, Capability, ProviderBinding, ProviderPlugin } from "../plugin-types";

/**
 * OpenRouter, as a provider rather than as an OpenAI-compatible endpoint.
 *
 * It used to be a five-line row in `api-key.ts` built with `createOpenAI`, which
 * reached `/chat/completions` and nothing else: no image generation, and no way
 * to express the two controls that are the entire reason to route through
 * OpenRouter — provider pinning and usage accounting.
 *
 * 🛑 Two SDK instances, on purpose. `OpenRouterProvider` has no
 * `transcriptionModel` and no `speechModel` (verified against the installed
 * `@openrouter/ai-sdk-provider@3.0.0` type declarations), while OpenRouter's
 * `/audio/transcriptions` route is real and `tasks/task-models.ts` already names
 * `openai/whisper-1` for it. So chat/image/embed come from `createOpenRouter` and
 * transcription from a `createOpenAI` instance pointed at the same base URL.
 * That second instance is also what keeps `transcription/sdk-result.ts` correct:
 * it keys Whisper language hints under `"openai"`, which stays true because the
 * transcription model really IS an `@ai-sdk/openai` model.
 */

const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";
const APP_NAME = "GenesisTools";
const APP_URL = "https://github.com/genesiscz/GenesisTools";

const CAPABILITIES: Capability[] = ["chat", "summarize", "translate", "image", "embed", "transcribe"];

/**
 * OpenRouter's provider-routing controls.
 *
 * `order` + `allow_fallbacks: false` is the load-bearing pair: it pins a model to
 * named upstreams (`{order: ["Morph", "DeepInfra"], allow_fallbacks: false}`),
 * which `ignore` alone cannot express because ignoring the providers you know
 * about still routes to the ones you do not.
 */
const providerRoutingSchema = z.object({
    order: z.array(z.string()).optional(),
    only: z.array(z.string()).optional(),
    ignore: z.array(z.string()).optional(),
    sort: z.enum(["price", "throughput", "latency"]).optional(),
    max_price: z
        .object({
            prompt: z.number().optional(),
            completion: z.number().optional(),
            image: z.number().optional(),
            audio: z.number().optional(),
            request: z.number().optional(),
        })
        .optional(),
    allow_fallbacks: z.boolean().optional(),
    require_parameters: z.boolean().optional(),
    data_collection: z.enum(["allow", "deny"]).optional(),
});

/** OpenRouter needs exactly one of `max_tokens` / `effort`; a block with neither is dropped. */
const reasoningSchema = z.object({
    enabled: z.boolean().optional(),
    exclude: z.boolean().optional(),
    max_tokens: z.number().optional(),
    effort: z.enum(["xhigh", "high", "medium", "low", "minimal", "none"]).optional(),
});

const overridesSchema = z.object({
    provider: providerRoutingSchema.optional(),
    /** OpenRouter's own fallback list: try these ids if the primary one fails. */
    models: z.array(z.string()).optional(),
    reasoning: reasoningSchema.optional(),
    usage: z.object({ include: z.boolean() }).optional(),
    /** Anything OpenRouter accepts that this schema does not name yet. */
    extraBody: z.record(z.string(), z.unknown()).optional(),
    appName: z.string().optional(),
    appUrl: z.string().optional(),
});

type OpenRouterAccountOverrides = z.infer<typeof overridesSchema>;

const KNOWN_OVERRIDE_KEYS = new Set(Object.keys(overridesSchema.shape));

/**
 * Per-account routing, read from `account.overrides.openrouter` — the schema's
 * declared escape hatch (`config/schema.ts`).
 *
 * The reader stays here rather than in `config/selectors.ts`, whose `override()`
 * helper is boolean-typed by design. Invalid input is logged and IGNORED rather
 * than thrown: a malformed routing hint must not stop the account from making
 * calls, and a silent throw at bind time reads as "the provider is broken".
 */
function readOverrides(account: AccountEntry): OpenRouterAccountOverrides {
    const raw = account.overrides?.openrouter;

    if (raw === undefined) {
        return {};
    }

    const parsed = overridesSchema.safeParse(raw);

    if (!parsed.success) {
        logger.warn(
            { accountId: account.id, issues: parsed.error.issues },
            "openrouter: account routing overrides are invalid and were ignored"
        );

        return {};
    }

    const unknown = Object.keys(raw as Record<string, unknown>).filter((key) => !KNOWN_OVERRIDE_KEYS.has(key));

    if (unknown.length > 0) {
        logger.debug({ accountId: account.id, unknown }, "openrouter: ignoring unrecognised routing override keys");
    }

    return parsed.data;
}

function reasoningSetting(
    reasoning: OpenRouterAccountOverrides["reasoning"]
): Pick<OpenRouterChatSettings, "reasoning"> {
    if (!reasoning) {
        return {};
    }

    const common = {
        ...(reasoning.enabled === undefined ? {} : { enabled: reasoning.enabled }),
        ...(reasoning.exclude === undefined ? {} : { exclude: reasoning.exclude }),
    };

    if (reasoning.max_tokens !== undefined) {
        return { reasoning: { ...common, max_tokens: reasoning.max_tokens } };
    }

    if (reasoning.effort !== undefined) {
        return { reasoning: { ...common, effort: reasoning.effort } };
    }

    return {};
}

/**
 * The bind-time chat settings the SDK folds into every outbound request body.
 *
 * 🛑 `usage.include` defaults ON. `usage.cost` is not free: the SDK asks for it
 * only in `strict` compatibility mode or when `usage.include === true`, and
 * `createOpenRouter` defaults to `compatible`. Without this the most precise cost
 * source available anywhere in this repo — OpenRouter's own reported charge for
 * the exact route it took — is simply never sent.
 */
function chatSettings(overrides: OpenRouterAccountOverrides): OpenRouterChatSettings {
    return {
        usage: overrides.usage ?? { include: true },
        ...(overrides.provider ? { provider: overrides.provider } : {}),
        ...(overrides.models ? { models: overrides.models } : {}),
        ...reasoningSetting(overrides.reasoning),
        ...(overrides.extraBody ? { extraBody: overrides.extraBody } : {}),
    };
}

export const openRouterPlugin: ProviderPlugin = {
    id: "openrouter",
    kind: "api-key",
    capabilities: new Set(CAPABILITIES),
    credential: { fields: ["apiKey"], envKeys: ["OPENROUTER_API_KEY"], required: ["apiKey"] },

    async bind(ctx: BindContext): Promise<ProviderBinding> {
        const { apiKey } = await resolveCredential(ctx.account, this.credential);

        if (!apiKey) {
            // resolveCredential enforces `required`, so this is unreachable; it
            // exists so the non-null assertion below is not needed.
            throw new Error("No API key resolved for openrouter");
        }

        const overrides = readOverrides(ctx.account);
        // `account.endpoint` is the schema's declared base-URL override for
        // OpenAI-compatible providers, and OpenRouter is one.
        const baseURL = ctx.account.endpoint ?? DEFAULT_BASE_URL;
        const settings = chatSettings(overrides);

        const provider = createOpenRouter({
            apiKey,
            baseURL,
            appName: overrides.appName ?? APP_NAME,
            appUrl: overrides.appUrl ?? APP_URL,
            ...(ctx.fetch ? { fetch: ctx.fetch } : {}),
        });

        const whisper = createOpenAI({
            apiKey,
            baseURL,
            ...(ctx.fetch ? { fetch: ctx.fetch } : {}),
        });

        return {
            accountId: ctx.account.id,
            providerId: "openrouter",
            billed: true,
            // `provider.chat(id, settings)`, NOT `getLanguageModel` — that helper
            // passes one argument, and every routing control this plugin exists
            // for lives in the second.
            language: (modelId: string) => provider.chat(modelId, settings),
            embedding: (modelId: string) => provider.textEmbeddingModel(modelId),
            image: (modelId: string) => provider.imageModel(modelId),
            transcription: (modelId: string) => whisper.transcription(modelId),
        };
    },
};
