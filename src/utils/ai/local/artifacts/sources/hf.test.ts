import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HfSource } from "./hf";

function modelDir(root: string, ...segments: string[]): string {
    const path = join(root, ...segments);
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, "config.json"), "{}");
    writeFileSync(join(path, "model.onnx"), "weights");

    return path;
}

function roots(): { hub: string; transformers: string } {
    const base = mkdtempSync(join(tmpdir(), "hf-source-"));

    return { hub: join(base, "hub"), transformers: join(base, "transformers") };
}

describe("HfSource.list", () => {
    test("reports the hub cache in its flat models-- layout", () => {
        const { hub, transformers } = roots();
        modelDir(hub, "models--Xenova--all-MiniLM-L6-v2");

        const listed = new HfSource(hub, transformers).list();

        expect(listed.map((a) => a.id)).toEqual(["Xenova/all-MiniLM-L6-v2"]);
        expect(listed[0].root).toBe(hub);
        expect(listed[0].sizeBytes).toBeGreaterThan(0);
    });

    /**
     * The cache that is actually used when `HF_HOME` is unset. Missing it made
     * `stats()` under-report by whole model directories and left `prune()`
     * unable to reclaim them.
     */
    test("reports the transformers.js cache in its nested org/name layout", () => {
        const { hub, transformers } = roots();
        modelDir(transformers, "Xenova", "bge-small-en");

        const listed = new HfSource(hub, transformers).list();

        expect(listed.map((a) => a.id)).toEqual(["Xenova/bge-small-en"]);
        expect(listed[0].root).toBe(transformers);
    });

    test("reports a bare-id transformers.js model that has no org directory", () => {
        const { hub, transformers } = roots();
        modelDir(transformers, "whisper-tiny");

        expect(new HfSource(hub, transformers).list().map((a) => a.id)).toEqual(["whisper-tiny"]);
    });

    test("reports both roots together, and neither when they are empty", () => {
        const { hub, transformers } = roots();

        expect(new HfSource(hub, transformers).list()).toEqual([]);

        modelDir(hub, "models--Xenova--all-MiniLM-L6-v2");
        modelDir(transformers, "Xenova", "bge-small-en");

        expect(
            new HfSource(hub, transformers)
                .list()
                .map((a) => a.id)
                .sort()
        ).toEqual(["Xenova/all-MiniLM-L6-v2", "Xenova/bge-small-en"]);
    });

    test("counts a model once when both roots resolve to the same directory", () => {
        const { hub } = roots();
        modelDir(hub, "models--Xenova--all-MiniLM-L6-v2");

        expect(new HfSource(hub, hub).list().map((a) => a.id)).toEqual(["Xenova/all-MiniLM-L6-v2"]);
    });
});

describe("HfSource.cachedPath", () => {
    test("returns the hub path when the model is in the hub layout", () => {
        const { hub, transformers } = roots();
        const path = modelDir(hub, "models--Xenova--all-MiniLM-L6-v2");

        expect(new HfSource(hub, transformers).cachedPath("Xenova/all-MiniLM-L6-v2")).toBe(path);
    });

    /**
     * `isCached` accepted this layout while `cachedPath` did not, so
     * `ArtifactStore.ensure` reported the model cached and handed back a hub path
     * that did not exist.
     */
    test("returns the transformers.js path for a model only in that layout", () => {
        const { hub, transformers } = roots();
        const path = modelDir(transformers, "Xenova", "bge-small-en");
        const source = new HfSource(hub, transformers);

        expect(source.cachedPath("Xenova/bge-small-en")).toBe(path);
        expect(source.isCached("Xenova/bge-small-en")).toBe(true);
    });

    test("a directory holding no model files is not a cache hit", () => {
        const { hub, transformers } = roots();
        mkdirSync(join(transformers, "Xenova", "empty"), { recursive: true });
        const source = new HfSource(hub, transformers);

        expect(source.cachedPath("Xenova/empty")).toBeNull();
        expect(source.isCached("Xenova/empty")).toBe(false);
    });

    test("an uncached model has no path at all", () => {
        const { hub, transformers } = roots();

        expect(new HfSource(hub, transformers).cachedPath("Xenova/never-downloaded")).toBeNull();
    });
});
