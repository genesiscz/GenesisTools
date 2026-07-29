import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { AiConfigStore } from "../config/AiConfigStore";
import { type AccountEntry, type AiConfigData, CONFIG_VERSION } from "../config/schema";
import type { BindContext, Capability, ProviderBinding, ProviderPlugin } from "../providers/plugin-types";
import { _resetBuiltInPluginsForTest } from "../providers/plugins";
import { _resetPluginsForTest, registerPlugin } from "../providers/registry";
import { ai } from "./facade";

/**
 * A binding is not garbage: a local runtime holds a loaded model per bind
 * (local/adapters/index.ts:102-139), and only `dispose()` frees it. Nothing in
 * the type system forces a caller to call it, so these tests are what stops a
 * verb from quietly leaking one — including on the failure path, which is the
 * one a `finally` exists for and the one nobody exercises by hand.
 */

let home: string;
const disposed: string[] = [];

function account(id: string, provider: string): AccountEntry {
    return {
        id,
        name: `${provider}-acct`,
        provider,
        enabled: true,
        billing: { mode: "metered" },
        credentials: {},
        useEnvApiKey: false,
    };
}

function writeConfig(accounts: AccountEntry[], defaults: AiConfigData["defaults"] = {}): void {
    const full: AiConfigData = { version: CONFIG_VERSION, accounts, defaults };
    mkdirSync(join(home, ".genesis-tools", "ai"), { recursive: true });
    writeFileSync(join(home, ".genesis-tools", "ai", "config.json"), SafeJSON.stringify(full, null, 2));
    AiConfigStore.invalidate();
}

/** `openai` is used as the id because `task-models.ts` can name a model for it on every task under test. */
function fakePlugin(
    id: string,
    capabilities: Capability[],
    methods: Partial<Pick<ProviderBinding, "language" | "embedding" | "transcription" | "image">>
): ProviderPlugin {
    return {
        id,
        kind: "api-key",
        capabilities: new Set(capabilities),
        credential: { fields: [], envKeys: [] },
        async bind(ctx: BindContext): Promise<ProviderBinding> {
            return {
                accountId: ctx.account.id,
                providerId: id,
                billed: true,
                language: () => {
                    throw new Error("no chat");
                },
                ...methods,
                dispose: () => {
                    disposed.push(id);
                },
            } as ProviderBinding;
        },
    };
}

const embeddingModel = {
    specificationVersion: "v3",
    provider: "openai",
    modelId: "text-embedding-3-small",
    maxEmbeddingsPerCall: 16,
    supportsParallelCalls: false,
    async doEmbed({ values }: { values: string[] }) {
        return { embeddings: values.map(() => [0.1, 0.2, 0.3]), warnings: [] };
    },
};

beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "gt-facade-dispose-"));
    env.testing.set("GENESIS_TOOLS_HOME", home);
    disposed.length = 0;
    AiConfigStore.invalidate();
    _resetPluginsForTest();
    _resetBuiltInPluginsForTest(true);
});

afterEach(() => {
    env.testing.unset("GENESIS_TOOLS_HOME");
    AiConfigStore.invalidate();
    _resetPluginsForTest();
    _resetBuiltInPluginsForTest();
});

describe("ai.* dispose the binding they resolve", () => {
    test("ai.embed disposes after a successful call", async () => {
        registerPlugin(
            fakePlugin("openai", ["embed"], {
                embedding: () => embeddingModel as never,
            })
        );
        writeConfig([account("acc_oa", "openai")]);

        const [result] = await ai.embed(["ahoj"]);

        expect(result.dimensions).toBe(3);
        expect(disposed).toEqual(["openai"]);
    });

    test("ai.embed disposes when the provider throws", async () => {
        registerPlugin(
            fakePlugin("openai", ["embed"], {
                embedding: () =>
                    ({
                        ...embeddingModel,
                        doEmbed: () => {
                            throw new Error("embedding backend exploded");
                        },
                    }) as never,
            })
        );
        writeConfig([account("acc_oa", "openai")]);

        await expect(ai.embed(["ahoj"])).rejects.toThrow(/exploded/);
        expect(disposed).toEqual(["openai"]);
    });

    test("ai.embed disposes even when the binding exposes no embedding model", async () => {
        registerPlugin(fakePlugin("openai", ["embed"], {}));
        writeConfig([account("acc_oa", "openai")]);

        await expect(ai.embed(["ahoj"])).rejects.toThrow();
        expect(disposed).toContain("openai");
    });

    test("ai.summarize disposes even though callLLM never resolved the binding", async () => {
        registerPlugin(fakePlugin("openai", ["summarize", "chat"], {}));
        writeConfig([account("acc_oa", "openai")], {
            task: { summarize: { provider: "openai", model: "gpt-4o-mini" } },
        });

        // `language()` throws on this fake, which is the point: the verb fails
        // and the binding must still be freed.
        await expect(ai.summarize("nejaky text")).rejects.toThrow(/no chat/);
        expect(disposed).toEqual(["openai"]);
    });

    test("ai.translate disposes on the failure path too", async () => {
        registerPlugin(fakePlugin("openai", ["translate", "chat"], {}));
        writeConfig([account("acc_oa", "openai")], {
            task: { translate: { provider: "openai", model: "gpt-4o-mini" } },
        });

        await expect(ai.translate("ahoj", { to: "en" })).rejects.toThrow(/no chat/);
        expect(disposed).toEqual(["openai"]);
    });

    test("ai.transcribe disposes through Transcriber", async () => {
        registerPlugin(
            fakePlugin("openai", ["transcribe"], {
                transcription: () =>
                    ({
                        specificationVersion: "v3",
                        provider: "openai",
                        modelId: "whisper-1",
                        doGenerate: () => {
                            throw new Error("asr backend exploded");
                        },
                    }) as never,
            })
        );
        writeConfig([account("acc_oa", "openai")]);

        await expect(ai.transcribe(Buffer.from("audio"))).rejects.toThrow(/exploded/);
        expect(disposed).toEqual(["openai"]);
    });
});
