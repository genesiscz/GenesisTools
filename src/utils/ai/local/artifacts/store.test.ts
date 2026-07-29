import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ArtifactRef } from "../descriptors/types";
import { HfSource } from "./sources/hf";
import { ArtifactStore } from "./store";

let root: string;
let hubDir: string;
let transformersDir: string;
let legacyRoot: string;

/**
 * The transformers.js root is pinned to a temp directory on purpose. `list()`
 * awaits `resolveTransformersCache()`, which otherwise asks the installed
 * library for its real `env.cacheDir`, a directory inside `node_modules` that
 * holds whatever models this machine has downloaded. Leaving it unpinned makes
 * these counts depend on the developer's cache and points `prune()` at it.
 */
function makeStore(fetcher?: (url: string) => Promise<ArrayBuffer>) {
    return new ArtifactStore({
        root,
        legacyRoots: [legacyRoot],
        hf: new HfSource(hubDir, transformersDir),
        fetcher,
    });
}

function writeHubModel(repoId: string, sizeBytes: number): string {
    const dir = join(hubDir, `models--${repoId.replace(/\//g, "--")}`, "snapshots", "abc");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "model.onnx"), Buffer.alloc(sizeBytes));

    return join(hubDir, `models--${repoId.replace(/\//g, "--")}`);
}

beforeEach(() => {
    const base = mkdtempSync(join(tmpdir(), "artifact-store-"));
    root = join(base, "local-models");
    hubDir = join(base, "hub");
    transformersDir = join(base, "transformers");
    legacyRoot = join(base, "legacy-sherpa");
    mkdirSync(root, { recursive: true });
    mkdirSync(hubDir, { recursive: true });
    mkdirSync(transformersDir, { recursive: true });
    mkdirSync(legacyRoot, { recursive: true });
});

afterEach(() => {
    rmSync(join(root, ".."), { recursive: true, force: true });
});

describe("ensure", () => {
    test("downloads a url artifact once and reports it cached the second time", async () => {
        const calls: string[] = [];
        const store = makeStore(async (url) => {
            calls.push(url);
            return new TextEncoder().encode("weights").buffer as ArrayBuffer;
        });

        const ref: ArtifactRef = {
            source: "url",
            locator: "https://example.invalid/campplus.onnx",
            file: join(root, "campplus.onnx"),
        };

        const first = await store.ensure([ref]);
        expect(first).toEqual([{ ref, path: ref.file as string, cached: false }]);
        expect(await Bun.file(ref.file as string).text()).toBe("weights");

        const second = await store.ensure([ref]);
        expect(second[0]?.cached).toBe(true);
        expect(calls).toEqual(["https://example.invalid/campplus.onnx"]);
    });

    test("derives a target path under the store root when the ref has no file", async () => {
        const store = makeStore(async () => new TextEncoder().encode("x").buffer as ArrayBuffer);

        const resolved = await store.ensure([{ source: "url", locator: "https://example.invalid/a/b/seg.onnx" }]);

        expect(resolved[0]?.path).toBe(join(root, "seg.onnx"));
        expect(existsSync(join(root, "seg.onnx"))).toBe(true);
    });

    test("verifies sha256 when the ref publishes one, and leaves nothing behind on mismatch", async () => {
        const store = makeStore(async () => new TextEncoder().encode("weights").buffer as ArrayBuffer);
        const file = join(root, "checked.onnx");

        await expect(
            store.ensure([{ source: "url", locator: "https://example.invalid/checked.onnx", file, sha256: "deadbeef" }])
        ).rejects.toThrow(/Checksum mismatch/);
        expect(existsSync(file)).toBe(false);
    });

    test("accepts a matching sha256", async () => {
        const bytes = new TextEncoder().encode("weights");
        const digest = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
        const store = makeStore(async () => bytes.buffer as ArrayBuffer);
        const file = join(root, "checked.onnx");

        const resolved = await store.ensure([
            { source: "url", locator: "https://example.invalid/checked.onnx", file, sha256: digest },
        ]);

        expect(resolved[0]?.cached).toBe(false);
    });

    test("extracts a tar.bz2 artifact and keeps no archive behind", async () => {
        const stage = join(root, "stage");
        mkdirSync(join(stage, "sherpa-onnx-pyannote-segmentation-3-0"), { recursive: true });
        writeFileSync(join(stage, "sherpa-onnx-pyannote-segmentation-3-0", "model.onnx"), Buffer.alloc(6));
        const archive = join(root, "seg.tar.bz2");
        await Bun.spawn(["tar", "cjf", archive, "-C", stage, "sherpa-onnx-pyannote-segmentation-3-0"]).exited;
        const archiveBytes = await Bun.file(archive).arrayBuffer();
        rmSync(stage, { recursive: true, force: true });
        rmSync(archive, { force: true });

        const target = join(root, "extracted");
        const store = makeStore(async () => archiveBytes);
        const resolved = await store.ensure([
            {
                source: "url",
                locator: "https://example.invalid/seg.tar.bz2",
                file: join(target, "sherpa-onnx-pyannote-segmentation-3-0", "model.onnx"),
                archive: "tar.bz2",
                archiveRoot: target,
            },
        ]);

        expect(resolved[0]?.cached).toBe(false);
        expect(existsSync(resolved[0]?.path as string)).toBe(true);
        expect((await store.list()).some((a) => a.id.endsWith(".tar.bz2"))).toBe(false);
    });

    test("an archive that does not yield the expected file is an error, not a silent success", async () => {
        const stage = join(root, "stage2");
        mkdirSync(join(stage, "other"), { recursive: true });
        writeFileSync(join(stage, "other", "unrelated.onnx"), Buffer.alloc(2));
        const archive = join(root, "other.tar.bz2");
        await Bun.spawn(["tar", "cjf", archive, "-C", stage, "other"]).exited;
        const archiveBytes = await Bun.file(archive).arrayBuffer();
        rmSync(stage, { recursive: true, force: true });
        rmSync(archive, { force: true });

        const store = makeStore(async () => archiveBytes);

        await expect(
            store.ensure([
                {
                    source: "url",
                    locator: "https://example.invalid/other.tar.bz2",
                    file: join(root, "extracted2", "expected", "model.onnx"),
                    archive: "tar.bz2",
                    archiveRoot: join(root, "extracted2"),
                },
            ])
        ).rejects.toThrow(/missing after download/);
    });

    test("resolves hf refs without fetching — transformers.js owns that download", async () => {
        const modelDir = writeHubModel("Xenova/multilingual-e5-small", 16);
        const store = makeStore(async () => {
            throw new Error("hf refs must not be fetched by the store");
        });

        const resolved = await store.ensure([
            { source: "hf", locator: "Xenova/multilingual-e5-small" },
            { source: "hf", locator: "not/downloaded" },
        ]);

        expect(resolved[0]).toEqual({
            ref: { source: "hf", locator: "Xenova/multilingual-e5-small" },
            path: modelDir,
            cached: true,
        });
        expect(resolved[1]?.cached).toBe(false);
        expect(resolved[1]?.path).toBe(join(hubDir, "models--not--downloaded"));
    });
});

describe("list", () => {
    test("sweeps the hf hub, the store root and the legacy sherpa root", async () => {
        writeHubModel("onnx-community/whisper-tiny", 32);
        writeFileSync(join(root, "seg.onnx"), Buffer.alloc(8));
        mkdirSync(join(legacyRoot, "sherpa-onnx-pyannote-segmentation-3-0"), { recursive: true });
        writeFileSync(join(legacyRoot, "sherpa-onnx-pyannote-segmentation-3-0", "model.onnx"), Buffer.alloc(4));

        const listed = await makeStore().list();
        const byId = new Map(listed.map((a) => [a.id, a]));

        expect(byId.get("onnx-community/whisper-tiny")?.source).toBe("hf");
        expect(byId.get("onnx-community/whisper-tiny")?.sizeBytes).toBe(32);
        expect(byId.get("seg.onnx")?.root).toBe(root);
        expect(byId.get("sherpa-onnx-pyannote-segmentation-3-0/model.onnx")?.root).toBe(legacyRoot);
        expect(listed.length).toBe(3);
    });

    test("stats sums every root", async () => {
        writeHubModel("onnx-community/whisper-tiny", 32);
        writeFileSync(join(root, "seg.onnx"), Buffer.alloc(8));

        const stats = await makeStore().stats();
        expect(stats.artifactCount).toBe(2);
        expect(stats.totalBytes).toBe(40);
        expect(stats.formatted).toBeString();
    });

    test("missing roots are not an error", async () => {
        rmSync(legacyRoot, { recursive: true, force: true });
        rmSync(hubDir, { recursive: true, force: true });

        expect(await makeStore().list()).toEqual([]);
    });
});

describe("prune", () => {
    test("removes only the requested ids", async () => {
        const keep = writeHubModel("onnx-community/whisper-tiny", 8);
        const drop = writeHubModel("Xenova/bge-m3", 16);

        const report = await makeStore().prune({ ids: ["Xenova/bge-m3"] });

        expect(report.removed.map((a) => a.id)).toEqual(["Xenova/bge-m3"]);
        expect(report.freedBytes).toBe(16);
        expect(existsSync(drop)).toBe(false);
        expect(existsSync(keep)).toBe(true);
    });

    test("removes only artifacts older than the cutoff", async () => {
        const old = writeHubModel("Xenova/bge-m3", 4);
        const fresh = writeHubModel("onnx-community/whisper-tiny", 4);
        const longAgo = new Date(Date.now() - 30 * 86_400_000);
        utimesSync(old, longAgo, longAgo);

        const report = await makeStore().prune({ olderThanDays: 7 });

        expect(report.removed.map((a) => a.id)).toEqual(["Xenova/bge-m3"]);
        expect(existsSync(old)).toBe(false);
        expect(existsSync(fresh)).toBe(true);
    });

    test("with no options it clears every root", async () => {
        writeHubModel("Xenova/bge-m3", 4);
        writeFileSync(join(root, "seg.onnx"), Buffer.alloc(2));

        const report = await makeStore().prune();

        expect(report.removed.length).toBe(2);
        expect(existsSync(join(root, "seg.onnx"))).toBe(false);
    });
});
