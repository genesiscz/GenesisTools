import { beforeEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@app/utils/json";
import { SayAudioCache, type SayCacheParams } from "./cache";

let dir: string;

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "say-cache-"));
});

const baseParams: SayCacheParams = {
    text: "hello",
    provider: "xai",
    voice: "v1",
    model: "tts-1",
    rate: 1,
    language: "en",
    format: "mp3",
};

describe("SayAudioCache", () => {
    it("returns null for cold cache", () => {
        const c = new SayAudioCache({ dir, threshold: 3 });
        expect(c.get(baseParams)).toBeNull();
    });

    it("does not persist audio until threshold is crossed", () => {
        const c = new SayAudioCache({ dir, threshold: 3 });
        c.recordMiss(baseParams, Buffer.from([1, 2]), "audio/mpeg");
        expect(c.get(baseParams)).toBeNull();
        c.recordMiss(baseParams, Buffer.from([1, 2]), "audio/mpeg");
        expect(c.get(baseParams)).toBeNull();
        // Third miss with audio crosses threshold and persists.
        c.recordMiss(baseParams, Buffer.from([1, 2, 3]), "audio/mpeg");
        const hit = c.get(baseParams);
        expect(hit).not.toBeNull();
        expect(Buffer.compare(hit!.audio, Buffer.from([1, 2, 3]))).toBe(0);
        expect(hit!.contentType).toBe("audio/mpeg");
    });

    it("skips caching when provider is macos", () => {
        const c = new SayAudioCache({ dir, threshold: 1 });
        c.recordMiss({ ...baseParams, provider: "macos" }, Buffer.from([9]), "audio/mpeg");
        expect(c.get({ ...baseParams, provider: "macos" })).toBeNull();
    });

    it("treats different texts as separate entries", () => {
        const c = new SayAudioCache({ dir, threshold: 1 });
        c.recordMiss({ ...baseParams, text: "a" }, Buffer.from([1]), "audio/mpeg");
        c.recordMiss({ ...baseParams, text: "b" }, Buffer.from([2]), "audio/mpeg");
        const a = c.get({ ...baseParams, text: "a" });
        const b = c.get({ ...baseParams, text: "b" });
        expect(a?.audio[0]).toBe(1);
        expect(b?.audio[0]).toBe(2);
    });

    it("treats different voices as separate entries even with the same text", () => {
        const c = new SayAudioCache({ dir, threshold: 1 });
        c.recordMiss({ ...baseParams, voice: "v1" }, Buffer.from([1]), "audio/mpeg");
        // Same text, different voice — should not hit the v1 cache.
        expect(c.get({ ...baseParams, voice: "v2" })).toBeNull();
    });

    it("evicts oldest persisted entry when over the size cap", () => {
        const c = new SayAudioCache({ dir, threshold: 1, maxBytes: 10 });
        c.recordMiss({ ...baseParams, text: "a" }, Buffer.alloc(8, 1), "audio/mpeg");
        // Bump lastUsed on b after a, so a is the oldest by access time.
        c.recordMiss({ ...baseParams, text: "b" }, Buffer.alloc(8, 2), "audio/mpeg");
        // Total persisted = 16 > 10 → evict a (the older one).
        expect(c.get({ ...baseParams, text: "a" })).toBeNull();
        expect(c.get({ ...baseParams, text: "b" })).not.toBeNull();
    });

    it("recovers from a deleted audio file: the next miss can re-persist", () => {
        const c = new SayAudioCache({ dir, threshold: 1 });
        c.recordMiss(baseParams, Buffer.from([1, 2]), "audio/mpeg");
        const firstHit = c.get(baseParams);
        expect(firstHit).not.toBeNull();

        // Simulate a manual deletion / eviction race: the audio file vanishes
        // but the index still references it.
        const canon = SafeJSON.stringify({
            t: baseParams.text,
            p: baseParams.provider,
            v: baseParams.voice ?? "",
            m: baseParams.model ?? "",
            r: baseParams.rate ?? 1,
            l: baseParams.language ?? "",
            f: baseParams.format ?? "",
        });
        const hash = createHash("sha256").update(canon).digest("hex").slice(0, 32);
        unlinkSync(join(dir, `${hash}.mp3`));

        // get() observes the missing file and clears the stale metadata.
        expect(c.get(baseParams)).toBeNull();

        // recordMiss with new audio should now persist (threshold=1) instead of skipping.
        c.recordMiss(baseParams, Buffer.from([9, 9, 9]), "audio/mpeg");
        const recovered = c.get(baseParams);
        expect(recovered).not.toBeNull();
        expect(Buffer.compare(recovered!.audio, Buffer.from([9, 9, 9]))).toBe(0);
    });

    it("stores the literal source text alongside each entry for inspection", () => {
        const c = new SayAudioCache({ dir, threshold: 5 });
        c.recordMiss({ ...baseParams, text: "hello world" });
        c.recordMiss({ ...baseParams, text: "hello world" });

        const raw = SafeJSON.parse(readFileSync(join(dir, "index.json"), "utf8")) as {
            entries: Record<string, { text?: string; count: number }>;
        };
        const entries = Object.values(raw.entries);
        expect(entries.length).toBe(1);
        expect(entries[0].text).toBe("hello world");
        expect(entries[0].count).toBe(2);
    });
});
