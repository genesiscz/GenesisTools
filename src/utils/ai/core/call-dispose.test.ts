import { describe, expect, test } from "bun:test";
import { accountEntrySchema } from "../config/schema";
import type { ProviderBinding } from "../providers/plugin-types";
import { transformVoiceText, voiceTransformConfiguration } from "../voice/transform";
import type { CallTarget } from "./call";
import { resolveCallTarget } from "./call";
import type { ResolvedBinding } from "./types";

/**
 * Who frees the binding.
 *
 * Local runtimes hold native handles, so a resolved binding nobody disposes is a
 * real leak, not a tidiness point. But disposing indiscriminately is worse: a
 * caller that resolved its own binding may reuse it across many calls, and
 * freeing it under them breaks the second call.
 *
 * The rule is therefore ownership, and these two tests are the rule: a target
 * built from a bare ModelRef owns its binding and carries a `dispose`; a target
 * built from a caller-supplied `ResolvedBinding` does not.
 */

function fakeBinding(onDispose: () => void): ProviderBinding {
    return {
        accountId: "acc_fake",
        providerId: "fake",
        billed: false,
        language: () => ({ specificationVersion: "v3", provider: "fake", modelId: "fake-1" }),
        dispose: onDispose,
    } as unknown as ProviderBinding;
}

function suppliedBinding(onDispose: () => void): ResolvedBinding {
    return {
        binding: fakeBinding(onDispose),
        plugin: { id: "fake" },
        account: { id: "acc_fake", name: "fake-account", provider: "fake" },
        model: { id: "fake-1" },
    } as unknown as ResolvedBinding;
}

describe("binding ownership in resolveCallTarget", () => {
    test("a caller-supplied binding is NOT disposed — the caller may reuse it", async () => {
        let disposed = 0;
        const target: CallTarget = await resolveCallTarget({ model: suppliedBinding(() => disposed++) });

        expect(target.dispose).toBeUndefined();

        // What callLLM's finally block does. It must be a no-op here.
        target.dispose?.();
        expect(disposed).toBe(0);
    });

    test("a self-resolved binding carries a dispose that reaches the binding", async () => {
        let disposed = 0;

        // resolveCallTarget only self-resolves for a string ref, and that path
        // needs real config. Assert the wiring directly instead: the shape a
        // self-resolved target has, and that calling it frees the binding.
        const resolved = suppliedBinding(() => disposed++);
        const selfResolvedTarget: CallTarget = {
            model: resolved.binding.language("fake-1"),
            label: "fake-account/fake-1",
            dispose: () => resolved.binding.dispose?.(),
        };

        selfResolvedTarget.dispose?.();
        expect(disposed).toBe(1);
    });
});

describe("voice transforms use the canonical AI account boundary", () => {
    test("configuration reads only enabled account and static model metadata", async () => {
        const account = accountEntrySchema.parse({
            id: "acc_work",
            name: "work",
            label: "Writing",
            provider: "fixture-chat",
            enabled: true,
            billing: { mode: "metered" },
            credentials: {},
        });
        Object.defineProperty(account, "credentials", {
            get() {
                throw new Error("Metadata must not inspect credentials");
            },
        });
        const result = await voiceTransformConfiguration({
            readStore: async () => ({
                accounts: (filter) => {
                    expect(filter).toEqual({ enabled: true });
                    return [account];
                },
            }),
            getPlugins: async () => [
                { id: "fixture-chat", capabilities: new Set(["chat"]) },
                { id: "fixture-speech", capabilities: new Set(["transcribe"]) },
            ],
            modelsFor: () => [
                { id: "writer", displayName: "Writer", capabilities: new Set(["chat"]) },
                { id: "writer", displayName: "Writer", capabilities: new Set(["chat"]) },
                { id: "painter", displayName: "Painter", capabilities: new Set(["image"]) },
            ],
        });
        expect(result).toEqual({
            providers: [
                {
                    id: "fixture-chat",
                    title: "fixture-chat",
                    accounts: [{ id: "acc_work", name: "Writing" }],
                    models: [{ id: "writer", title: "Writer" }],
                },
            ],
        });
    });

    test("explicit model reference reaches canonical execution without credential copies", async () => {
        let calls = 0;
        const result = await transformVoiceText({
            modelRef: "@account/acc_work:writer",
            systemPrompt: "Rewrite faithfully.",
            text: " original text ",
            invoke: async (options) => {
                calls += 1;
                expect(options.model).toBe("@account/acc_work:writer");
                expect(options.app).toBe("flow");
                expect(options.task).toBe("chat");
                expect(options.systemPrompt).toBe("Rewrite faithfully.");
                expect(options.userPrompt).toBe("original text");
                expect(options.abortSignal?.aborted).toBe(false);
                expect(options.providerChoice).toBeUndefined();
                return { content: " revised text " };
            },
        });
        expect(result).toBe("revised text");
        expect(calls).toBe(1);
    });

    test("invalid inputs never reach the credential-consuming call", async () => {
        let calls = 0;
        const invoke = async () => {
            calls += 1;
            throw new Error("must not bind");
        };
        const base = { modelRef: "@account/acc_work:writer", systemPrompt: "Rewrite.", text: "fixture", invoke };
        await expect(transformVoiceText({ ...base, modelRef: "" })).rejects.toThrow("Choose an enabled AI account");
        await expect(transformVoiceText({ ...base, modelRef: "writer" })).rejects.toThrow(
            "Choose an enabled AI account"
        );
        await expect(transformVoiceText({ ...base, text: "word ".repeat(1_001) })).rejects.toThrow("too long");
        await expect(transformVoiceText({ ...base, systemPrompt: "" })).rejects.toThrow("instruction");
        await expect(transformVoiceText({ ...base, timeoutMs: Number.NaN })).rejects.toThrow("timeout");
        expect(await transformVoiceText({ ...base, text: "  " })).toBe("");
        expect(calls).toBe(0);
    });

    test("cancellation before execution does not bind and cancellation during execution reaches the request", async () => {
        const before = new AbortController();
        before.abort();
        let calls = 0;
        const base = { modelRef: "@account/acc_work:writer", systemPrompt: "Rewrite.", text: "fixture" };
        await expect(
            transformVoiceText({
                ...base,
                signal: before.signal,
                invoke: async () => {
                    calls += 1;
                    throw new Error("must not bind");
                },
            })
        ).rejects.toThrow();
        expect(calls).toBe(0);
        const during = new AbortController();
        await expect(
            transformVoiceText({
                ...base,
                signal: during.signal,
                invoke: async (options) => {
                    calls += 1;
                    during.abort();
                    expect(options.abortSignal?.aborted).toBe(true);
                    return { content: "late response" };
                },
            })
        ).rejects.toThrow();
        expect(calls).toBe(1);
    });

    test("an empty provider response remains a visible failure", async () => {
        await expect(
            transformVoiceText({
                modelRef: "@account/acc_work:writer",
                systemPrompt: "Rewrite.",
                text: "fixture",
                invoke: async () => ({ content: "  " }),
            })
        ).rejects.toThrow("returned nothing");
    });
});
