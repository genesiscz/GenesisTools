import { byProvider, catalogKeysFor } from "@genesiscz/utils/ai/catalog";
import { AiConfigStore } from "@genesiscz/utils/ai/config/AiConfigStore";
import type { CallLLMOptions, CallLLMResult } from "@genesiscz/utils/ai/core/call";
import type { ProviderPlugin } from "@genesiscz/utils/ai/providers/plugin-types";
import { logger } from "@genesiscz/utils/logger";

type ChatPlugin = Pick<ProviderPlugin, "id" | "capabilities">;

async function chatPlugins(): Promise<ChatPlugin[]> {
    const { registerBuiltInPlugins } = await import("@genesiscz/utils/ai/providers/plugins");
    const { pluginsByCapability } = await import("@genesiscz/utils/ai/providers/registry");
    registerBuiltInPlugins();
    return pluginsByCapability("chat");
}

/** Metadata only: no binding, credential resolution, refresh or provider request. */
export async function voiceTransformConfiguration({
    readStore = AiConfigStore.readOnly,
    getPlugins = chatPlugins,
    modelsFor = (provider: string) => catalogKeysFor(provider).flatMap(byProvider),
}: {
    readStore?: () => Promise<Pick<AiConfigStore, "accounts">>;
    getPlugins?: () => Promise<ChatPlugin[]>;
    modelsFor?: (provider: string) => Array<{ id: string; displayName: string; capabilities: ReadonlySet<string> }>;
} = {}) {
    const store = await readStore();
    const accounts = store.accounts({ enabled: true });
    const providers = (await getPlugins())
        .filter((plugin) => plugin.capabilities.has("chat"))
        .map((plugin) => ({
            id: plugin.id,
            title: plugin.id,
            accounts: accounts
                .filter((account) => account.provider === plugin.id)
                .map((account) => ({ id: account.id, name: account.label || account.name })),
            models: [
                ...new Map(
                    modelsFor(plugin.id)
                        .filter((model) => model.capabilities.has("chat"))
                        .map((model) => [model.id, { id: model.id, title: model.displayName }])
                ).values(),
            ],
        }))
        .filter((provider) => provider.accounts.length > 0)
        .sort((left, right) => left.title.localeCompare(right.title));
    logger.debug({ providers: providers.length }, "Read text-transform configuration metadata");
    return { providers };
}

export interface VoiceTransformRequest {
    systemPrompt: string;
    text: string;
    modelRef: string;
    timeoutMs?: number;
    signal?: AbortSignal;
}

/** Deliberate rewriting uses the canonical account resolver and usage ledger. */
export async function transformVoiceText({
    systemPrompt,
    text,
    modelRef,
    timeoutMs = 30_000,
    signal,
    invoke,
}: VoiceTransformRequest & {
    invoke?: (options: CallLLMOptions) => Promise<Pick<CallLLMResult, "content">>;
}): Promise<string> {
    const content = text.trim();
    const instruction = systemPrompt.trim();

    if (!content) {
        return "";
    }

    if (content.split(/\s+/u).length > 1_000) {
        throw new Error("That is too long to transform in one pass (1,000 words maximum).");
    }

    if (!instruction || instruction.length > 32_000) {
        throw new Error("A transform needs an instruction of at most 32,000 characters.");
    }

    if (!/^@account\/acc_[a-z0-9][a-z0-9_-]*:\S+$/u.test(modelRef)) {
        throw new Error("Choose an enabled AI account and a model in Dictation → Text transforms.");
    }

    if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
        throw new Error("Transform timeout must be between 1 and 120,000 milliseconds.");
    }

    signal?.throwIfAborted();
    const timeout = AbortSignal.timeout(Math.ceil(timeoutMs));
    const abortSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const call = invoke ?? (await import("@genesiscz/utils/ai/core/call")).callLLM;
    logger.debug({ modelRef, characters: content.length }, "Run explicitly requested text transform");
    const result = await call({
        model: modelRef,
        task: "chat",
        app: "flow",
        systemPrompt: instruction,
        userPrompt: content,
        temperature: 0.2,
        abortSignal,
    });
    abortSignal.throwIfAborted();
    const rewritten = result.content.trim();

    if (!rewritten) {
        throw new Error("The model returned nothing.");
    }

    return rewritten;
}
