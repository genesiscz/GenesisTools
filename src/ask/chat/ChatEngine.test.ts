import { describe, expect, test } from "bun:test";
import { ChatEngine } from "@ask/chat/ChatEngine";
import type { ChatConfig, DetectedProvider, ModelInfo, ProviderChoice } from "@ask/types";
import type { AiSdkProvider } from "@genesiscz/utils/ask/types/provider";
import type { LanguageModel } from "ai";

/**
 * `callTarget()` is private, but every field it reads is public through
 * `getConfig()`, and those fields ARE the attribution: `logUsage` falls back to
 * `accountId: "unknown"` and a `<provider>/<model>` label that `catalogPricing`
 * can never match, so a stale field writes an unpriced, unattributed row into an
 * append-only log. Pinning the fields pins the attribution.
 */
function model(id: string): LanguageModel {
    return { specificationVersion: "v3", provider: "test", modelId: id } as unknown as LanguageModel;
}

function modelInfo(name: string, modelId: string): ModelInfo {
    return { id: modelId, name: modelId, contextWindow: 200_000, capabilities: [], provider: name };
}

function choice(name: string, type: string, modelId: string, systemPromptPrefix?: string): ProviderChoice {
    const provider: DetectedProvider = {
        name,
        type,
        key: "k",
        provider: {} as AiSdkProvider,
        models: [modelInfo(name, modelId)],
        config: { name, envKey: "NONE" } as DetectedProvider["config"],
        subscription: type.endsWith("-sub"),
        account: { name: `${name}-account` },
        ...(systemPromptPrefix ? { systemPromptPrefix } : {}),
    };

    return { provider, model: modelInfo(name, modelId) };
}

function engineOn(start: ProviderChoice): ChatEngine {
    const config: ChatConfig = {
        model: model(start.model.id),
        provider: start.provider.name,
        modelName: start.model.id,
        streaming: false,
        providerChoice: start,
        providerType: start.provider.type,
    };

    return new ChatEngine(config);
}

describe("ChatEngine.switchModel", () => {
    /**
     * The defect this pins: `/model` can move a session to a different provider
     * TYPE, and switchModel updated only the name and the model. Everything after
     * a switch was therefore recorded against the provider the session started
     * on, and the subscription system-prompt prefix came from the old one too.
     */
    test("a switch across provider types moves the type and the choice with it", async () => {
        const engine = engineOn(choice("anthropic", "anthropic-sub", "claude-opus-5", "You are Claude Code"));
        const next = choice("xai", "xai", "grok-4.5");

        await engine.switchModel(model("grok-4.5"), next.provider.name, next.model.id, next);

        const config = engine.getConfig();
        expect(config.provider).toBe("xai");
        expect(config.modelName).toBe("grok-4.5");
        expect(config.providerType).toBe("xai");
        expect(config.providerChoice?.provider.account?.name).toBe("xai-account");
        expect(config.providerChoice?.provider.systemPromptPrefix).toBeUndefined();
    });

    test("switching without a choice leaves the previous one rather than clearing it", async () => {
        const start = choice("anthropic", "anthropic-sub", "claude-opus-5");
        const engine = engineOn(start);

        await engine.switchModel(model("claude-sonnet-5"), "anthropic", "claude-sonnet-5");

        const config = engine.getConfig();
        expect(config.modelName).toBe("claude-sonnet-5");
        // A same-provider switch is the common case and must not lose the account.
        expect(config.providerType).toBe("anthropic-sub");
        expect(config.providerChoice?.provider.account?.name).toBe("anthropic-account");
    });

    test("the subscription prefix follows the switch", async () => {
        const engine = engineOn(choice("xai", "xai", "grok-4.5"));
        const next = choice("anthropic", "anthropic-sub", "claude-opus-5", "You are Claude Code");

        await engine.switchModel(model("claude-opus-5"), next.provider.name, next.model.id, next);

        expect(engine.getConfig().providerChoice?.provider.systemPromptPrefix).toBe("You are Claude Code");
    });
});
