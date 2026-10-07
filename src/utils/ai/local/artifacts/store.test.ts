import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    rmSync,
    symlinkSync,
    utimesSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ArtifactRef } from "../descriptors/types";
import { HfSource } from "./sources/hf";
import { parseTarVerboseListing, UrlSource } from "./sources/url";
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
        await Bun.spawn(["tar", "cjf", archive, "-C", stage, "sherpa-onnx-pyannote-segmentation-3-0"], {
            env: process.env,
        }).exited;
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
        expect(readdirSync(root).some((name) => name.includes(".download-"))).toBe(false);
    });

    test("re-extracts into an archive directory that lost its file to a prune", async () => {
        const stage = join(root, "stage-pruned");
        mkdirSync(join(stage, "seg-pruned"), { recursive: true });
        writeFileSync(join(stage, "seg-pruned", "model.onnx"), Buffer.alloc(6));
        const archive = join(root, "pruned.tar.bz2");
        await Bun.spawn(["tar", "cjf", archive, "-C", stage, "seg-pruned"], { env: process.env }).exited;
        const archiveBytes = await Bun.file(archive).arrayBuffer();
        rmSync(stage, { recursive: true, force: true });
        rmSync(archive, { force: true });

        const target = join(root, "extracted-pruned");
        const file = join(target, "seg-pruned", "model.onnx");
        // What a prune leaves behind: the parent directory with a leftover, the model file gone.
        mkdirSync(join(target, "seg-pruned"), { recursive: true });
        writeFileSync(join(target, "seg-pruned", "stale.txt"), "left over");
        const store = makeStore(async () => archiveBytes);

        const resolved = await store.ensure([
            {
                source: "url",
                locator: "https://example.invalid/pruned.tar.bz2",
                file,
                archive: "tar.bz2",
                archiveRoot: target,
            },
        ]);

        expect(resolved[0]?.cached).toBe(false);
        expect(existsSync(file)).toBe(true);
        expect(existsSync(join(target, "seg-pruned", "stale.txt"))).toBe(false);
        expect(readdirSync(target).filter((name) => name.startsWith("."))).toEqual([]);
    });

    test("an archive that does not yield the expected file is an error, not a silent success", async () => {
        const stage = join(root, "stage2");
        mkdirSync(join(stage, "other"), { recursive: true });
        writeFileSync(join(stage, "other", "unrelated.onnx"), Buffer.alloc(2));
        const archive = join(root, "other.tar.bz2");
        await Bun.spawn(["tar", "cjf", archive, "-C", stage, "other"], { env: process.env }).exited;
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

    test("streams a response into the final file without publishing the staging name", async () => {
        let pulls = 0;
        const source = new UrlSource({
            fetcher: async () =>
                new Response(
                    new ReadableStream<Uint8Array>({
                        pull(controller) {
                            pulls += 1;
                            controller.enqueue(new TextEncoder().encode(`chunk-${pulls}\n`));
                            if (pulls === 3) {
                                controller.close();
                            }
                        },
                    })
                ),
            maxDownloadBytes: 1024,
        });
        const file = join(root, "streamed.onnx");

        await source.ensure({ source: "url", locator: "https://example.invalid/streamed.onnx", file });

        expect(await Bun.file(file).text()).toBe("chunk-1\nchunk-2\nchunk-3\n");
        expect(readdirSync(root).some((name) => name.includes(".download-"))).toBe(false);
    });

    test("rejects a chunked overflow and publishes no file", async () => {
        const source = new UrlSource({
            fetcher: async () =>
                new Response(
                    new ReadableStream<Uint8Array>({
                        start(controller) {
                            controller.enqueue(new Uint8Array(6));
                            controller.enqueue(new Uint8Array(6));
                            controller.close();
                        },
                    })
                ),
            maxDownloadBytes: 8,
        });
        const file = join(root, "oversized.onnx");

        await expect(
            source.ensure({ source: "url", locator: "https://example.invalid/oversized.onnx", file })
        ).rejects.toThrow(/exceeds 8 bytes/);
        expect(existsSync(file)).toBe(false);
        expect(readdirSync(root).some((name) => name.includes(".download-"))).toBe(false);
    });

    test("cleans the staged file when a response stream aborts", async () => {
        const source = new UrlSource({
            fetcher: async () =>
                new Response(
                    new ReadableStream<Uint8Array>({
                        start(controller) {
                            controller.enqueue(new Uint8Array([1, 2, 3]));
                            controller.error(new Error("synthetic stream abort"));
                        },
                    })
                ),
        });
        const file = join(root, "aborted.onnx");

        await expect(
            source.ensure({ source: "url", locator: "https://example.invalid/aborted.onnx", file })
        ).rejects.toThrow(/synthetic stream abort/);
        expect(existsSync(file)).toBe(false);
        expect(readdirSync(root).some((name) => name.includes(".download-"))).toBe(false);
    });

    test("rejects an oversized Content-Length before pulling the response body", async () => {
        let pulls = 0;
        let canceled = false;
        const source = new UrlSource({
            fetcher: async () =>
                new Response(
                    new ReadableStream<Uint8Array>({
                        pull(controller) {
                            pulls += 1;
                            controller.enqueue(new Uint8Array(1));
                        },
                        cancel() {
                            canceled = true;
                        },
                    }),
                    { headers: { "content-length": "9" } }
                ),
            maxDownloadBytes: 8,
        });
        const file = join(root, "declared-oversized.onnx");

        await expect(
            source.ensure({ source: "url", locator: "https://example.invalid/declared.onnx", file })
        ).rejects.toThrow(/exceeds 8 bytes/);
        expect(pulls).toBeLessThanOrEqual(1);
        expect(canceled).toBe(true);
        expect(existsSync(file)).toBe(false);
    });

    test("rejects an archive whose declared expansion exceeds its budget before publish", async () => {
        const stage = join(root, "bounded-stage");
        mkdirSync(join(stage, "model"), { recursive: true });
        writeFileSync(join(stage, "model", "model.onnx"), Buffer.alloc(16));
        const archive = join(root, "bounded.tar.bz2");
        await Bun.spawn(["tar", "cjf", archive, "-C", stage, "model"], { env: process.env }).exited;
        const archiveBytes = await Bun.file(archive).arrayBuffer();
        const target = join(root, "bounded-target");
        const source = new UrlSource({
            fetcher: async () => archiveBytes,
            maxArchiveExpandedBytes: 8,
        });

        await expect(
            source.ensure({
                source: "url",
                locator: "https://example.invalid/bounded.tar.bz2",
                file: join(target, "model", "model.onnx"),
                archive: "tar.bz2",
                archiveRoot: target,
            })
        ).rejects.toThrow(/expanded size/);
        expect(existsSync(target)).toBe(false);
    });

    test("rejects archive links before extraction", async () => {
        const stage = join(root, "link-stage");
        mkdirSync(join(stage, "model"), { recursive: true });
        symlinkSync("/tmp/synthetic-outside", join(stage, "model", "model.onnx"));
        const archive = join(root, "link.tar.bz2");
        await Bun.spawn(["tar", "cjf", archive, "-C", stage, "model"], { env: process.env }).exited;
        const archiveBytes = await Bun.file(archive).arrayBuffer();
        const target = join(root, "link-target");
        const source = new UrlSource(async () => archiveBytes);

        await expect(
            source.ensure({
                source: "url",
                locator: "https://example.invalid/link.tar.bz2",
                file: join(target, "model", "model.onnx"),
                archive: "tar.bz2",
                archiveRoot: target,
            })
        ).rejects.toThrow(/link or unsupported entry/);
        expect(existsSync(target)).toBe(false);
    });
});

describe("tar verbose listing", () => {
    test("counts both BSD and GNU tar size columns", () => {
        const bsd = [
            "drwxr-xr-x  0 work staff       0 Oct  6 23:15 model/",
            "-rw-r--r--  0 work staff      16 Oct  6 23:15 model/model.onnx",
        ].join("\n");
        const gnu = [
            "drwxr-xr-x work/staff 0 2026-10-06 23:15 model/",
            "-rw-r--r-- work/staff 16 2026-10-06 23:15 model/model.onnx",
        ].join("\n");

        expect(parseTarVerboseListing(bsd, 32)).toBe(16);
        expect(parseTarVerboseListing(gnu, 32)).toBe(16);
    });

    test("rejects links and portable-listing overflow", () => {
        expect(() => parseTarVerboseListing("lrwxr-xr-x work/staff 0 2026-10-06 link -> /tmp/x", 32)).toThrow(
            /link or unsupported/
        );
        expect(() => parseTarVerboseListing("-rw-r--r-- work/staff 33 2026-10-06 model/model.onnx", 32)).toThrow(
            /expanded size/
        );
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
