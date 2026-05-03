import { beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
});
