import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EmbeddingModel } from "ai";
import type { AccountEntry } from "../../config/schema";
import type { ProviderPlugin } from "../../providers/plugin-types";
import { ArtifactStore, HfSource } from "../artifacts";
import { descriptorsFor, localPlugins, modelStatesFor } from "./index";

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

describe("descriptor-driven model listing", () => {
    test("every plugin's models come from the catalogue, keyed by provider", () => {
        expect(descriptorsFor("local-hf").every((d) => d.provider === "local-hf" && d.task === "embed")).toBe(true);
        expect(descriptorsFor("coreml").map((d) => d.id)).toEqual(["coreml-contextual"]);
        expect(descriptorsFor("darwinkit").map((d) => d.id)).toEqual(["darwinkit"]);
        expect(descriptorsFor("macos")).toEqual([]);
    });

    test("transformers.js models each carry the hf artifact the store resolves", () => {
        for (const descriptor of descriptorsFor("local-hf")) {
            expect(descriptor.runtime).toBe("transformers-js");
            expect(descriptor.artifacts).toEqual([{ source: "hf", locator: descriptor.id }]);
        }
    });

    test("cached-state is resolved through the artifact store, not guessed", async () => {
        const base = mkdtempSync(join(tmpdir(), "adapters-"));
        const hubDir = join(base, "hub");
        const downloaded = "Xenova/all-MiniLM-L6-v2";
        mkdirSync(join(hubDir, `models--${downloaded.replace(/\//g, "--")}`), { recursive: true });
        writeFileSync(join(hubDir, `models--${downloaded.replace(/\//g, "--")}`, "model.onnx"), Buffer.alloc(4));

        try {
            const store = new ArtifactStore({ root: join(base, "local-models"), hf: new HfSource(hubDir) });
            const states = await modelStatesFor("local-hf", store);
            const byId = new Map(states.map((s) => [s.descriptor.id, s.cached]));

            expect(byId.get(downloaded)).toBe(true);
            expect(byId.get("Xenova/multilingual-e5-small")).toBe(false);
            expect(states.length).toBe(descriptorsFor("local-hf").length);
        } finally {
            rmSync(base, { recursive: true, force: true });
        }
    });

    test("models with no artifacts of ours count as cached — nothing to download", async () => {
        const base = mkdtempSync(join(tmpdir(), "adapters-builtin-"));

        try {
            const store = new ArtifactStore({ root: base, hf: new HfSource(join(base, "hub")) });

            expect(await modelStatesFor("coreml", store)).toEqual([
                { descriptor: descriptorsFor("coreml")[0], cached: true },
            ]);
            expect(await modelStatesFor("darwinkit", store)).toEqual([
                { descriptor: descriptorsFor("darwinkit")[0], cached: true },
            ]);
        } finally {
            rmSync(base, { recursive: true, force: true });
        }
    });
});
