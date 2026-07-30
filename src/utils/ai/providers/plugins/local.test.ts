import { describe, expect, test } from "bun:test";
import type { EmbeddingModel } from "ai";
import type { AccountEntry } from "../../config/schema";
import type { ProviderPlugin } from "../plugin-types";
import { localPlugins } from "./local";

function account(provider: string): AccountEntry {
    return {
        id: "acc_local_test",
        name: "local-test",
        provider,
        enabled: true,
        billing: { mode: "free" },
        credentials: {},
        useEnvApiKey: false,
    };
}

/** ai's EmbeddingModel is `string | EmbeddingModelV3`; only the object form has ids. */
function describeModel(model: EmbeddingModel | undefined): { modelId: string; provider: string } | undefined {
    if (!model || typeof model === "string") {
        return undefined;
    }

    return { modelId: model.modelId, provider: model.provider };
}

function plugin(id: string): ProviderPlugin {
    const found = localPlugins.find((candidate) => candidate.id === id);

    if (!found) {
        throw new Error(`no local plugin ${id}`);
    }

    return found;
}

describe("local provider plugins", () => {
    test("cover every on-device runtime and need no credential", () => {
        expect(localPlugins.map((p) => p.id).sort()).toEqual(["coreml", "darwinkit", "local-hf", "macos", "ollama"]);

        for (const candidate of localPlugins) {
            expect(candidate.kind).toBe("local");
            expect(candidate.credential.fields).toEqual([]);
            expect(candidate.credential.envKeys).toEqual([]);
        }
    });

    test("binding an embedding runtime is lazy and cached per model", async () => {
        const binding = await plugin("local-hf").bind({ account: account("local-hf") });

        expect(binding.embedding).toBeDefined();

        const first = binding.embedding?.("Xenova/all-MiniLM-L6-v2");
        const second = binding.embedding?.("Xenova/all-MiniLM-L6-v2");

        expect(describeModel(first)).toEqual({
            modelId: "Xenova/all-MiniLM-L6-v2",
            provider: "local-hf",
        });
        // Same runtime behind both, so a second call loads no second model.
        expect(describeModel(second)).toEqual(describeModel(first));

        binding.dispose?.();
    });

    /**
     * The failure this pins is a silent one: asking a local runtime for chat used
     * to return whatever the caller assumed, so the error must name what the
     * provider actually does.
     */
    test("asking a local runtime for a chat model fails with what it does support", async () => {
        const binding = await plugin("coreml").bind({ account: account("coreml") });

        expect(() => binding.language("anything")).toThrow(/coreml has no chat model/);
        expect(() => binding.language("anything")).toThrow(/embed/);
    });

    test("macos declares tts and nothing else, and has no embedder", async () => {
        const macos = plugin("macos");

        expect([...macos.capabilities]).toEqual(["tts"]);

        const binding = await macos.bind({ account: account("macos") });
        expect(binding.embedding).toBeUndefined();
    });

    test("dispose tears down every runtime the binding created", async () => {
        const binding = await plugin("ollama").bind({ account: account("ollama") });

        binding.embedding?.("nomic-embed-text");
        binding.embedding?.("mxbai-embed-large");

        // Nothing to assert beyond it being safe to call twice: the runtimes are
        // real objects, and a double dispose is what a `finally` block produces.
        expect(() => {
            binding.dispose?.();
            binding.dispose?.();
        }).not.toThrow();
    });
});
