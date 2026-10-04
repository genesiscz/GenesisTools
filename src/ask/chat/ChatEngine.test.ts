import { describe, expect, it, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatEngine } from "@ask/chat/ChatEngine";
import type { ChatConfig, DetectedProvider, ModelInfo, ProviderChoice } from "@ask/types";
import type { ChatSession } from "@genesiscz/utils/ask/types/chat";
import type { AiSdkProvider } from "@genesiscz/utils/ask/types/provider";
import { logger } from "@genesiscz/utils/logger";
import type { LanguageModel } from "ai";
import { ConversationManager } from "./ConversationManager";

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

function makeSession(id: string): ChatSession {
    return {
        id,
        model: "model-x",
        provider: "provider-x",
        startTime: new Date().toISOString(),
        messages: [],
    };
}

describe("ConversationManager", () => {
    // Regression test: #446 item 6 — `tools ask --help` created
    // ~/.genesis-tools/ask/conversations because the constructor created the
    // directory eagerly, before any conversation was ever saved.
    it("does not create the conversations directory on construction", () => {
        const dir = join(mkdtempSync(join(tmpdir(), "gt-ask-conv-")), "conversations");

        new ConversationManager(dir);

        expect(existsSync(dir)).toBe(false);
    });

    it("creates the conversations directory the first time a conversation is saved", async () => {
        const dir = join(mkdtempSync(join(tmpdir(), "gt-ask-conv-")), "conversations");
        const manager = new ConversationManager(dir);

        await manager.saveConversation(makeSession("sess-1"));

        expect(existsSync(dir)).toBe(true);
        rmSync(dir, { recursive: true, force: true });
    });

    // Regression test: PR #456 review — with the directory created on first save, a fresh install
    // answered a conversation listing by logging "Failed to list conversations" for the normal empty state
    it("lists nothing and logs no error before the first conversation is saved", async () => {
        const dir = join(mkdtempSync(join(tmpdir(), "gt-ask-conv-")), "conversations");
        const errors = spyOn(logger, "error").mockImplementation(() => undefined);
        errors.mockClear();

        try {
            expect(await new ConversationManager(dir).listConversations()).toEqual([]);
            expect(errors).not.toHaveBeenCalled();
        } finally {
            errors.mockRestore();
        }
    });

    it("still logs a listing failure that is not a missing directory", async () => {
        const notADirectory = join(mkdtempSync(join(tmpdir(), "gt-ask-conv-")), "conversations");
        writeFileSync(notADirectory, "a file where the directory should be\n");
        const errors = spyOn(logger, "error").mockImplementation(() => undefined);
        errors.mockClear();

        try {
            expect(await new ConversationManager(notADirectory).listConversations()).toEqual([]);
            expect(errors).toHaveBeenCalledTimes(1);
        } finally {
            errors.mockRestore();
        }
    });
});
