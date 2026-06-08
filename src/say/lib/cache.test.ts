import { beforeEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
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

    it("falls back to an empty index when index.json has the wrong shape", () => {
        // Valid JSON, but neither a version-1 IndexShape nor garbage that would
        // fail SafeJSON.parse. Without shape validation, the next access to
        // `idx.entries[key]` would throw on undefined.
        writeFileSync(join(dir, "index.json"), "{}");
        const c = new SayAudioCache({ dir, threshold: 1 });
        expect(() => c.recordMiss(baseParams, Buffer.from([1]), "audio/mpeg")).not.toThrow();
        // After the recovery write, the file is now well-formed.
        const raw = SafeJSON.parse(readFileSync(join(dir, "index.json"), "utf8")) as {
            version: number;
            entries: Record<string, unknown>;
        };
        expect(raw.version).toBe(1);
        expect(Object.keys(raw.entries).length).toBe(1);
    });

    it("falls back when index.json is an array (wrong type)", () => {
        writeFileSync(join(dir, "index.json"), "[]");
        const c = new SayAudioCache({ dir, threshold: 1 });
        expect(() => c.recordMiss(baseParams, Buffer.from([1]), "audio/mpeg")).not.toThrow();
    });

    const backdateAllEntries = (ageMs: number): void => {
        const idxPath = join(dir, "index.json");
        const idx = SafeJSON.parse(readFileSync(idxPath, "utf8")) as {
            version: number;
            entries: Record<string, { lastUsed: number }>;
        };

        for (const e of Object.values(idx.entries)) {
            e.lastUsed = Date.now() - ageMs;
        }

        writeFileSync(idxPath, SafeJSON.stringify(idx, null, 2));
    };

    const readTexts = (): Array<string | undefined> => {
        const raw = SafeJSON.parse(readFileSync(join(dir, "index.json"), "utf8")) as {
            entries: Record<string, { text?: string }>;
        };
        return Object.values(raw.entries).map((e) => e.text);
    };

    it("prunes stale counter entries older than ttlMs on the next recordMiss", () => {
        const c = new SayAudioCache({ dir, threshold: 5, ttlMs: 86_400_000 });
        c.recordMiss({ ...baseParams, text: "stale" });
        backdateAllEntries(48 * 60 * 60 * 1000); // 48h ago — older than the 24h TTL

        // A miss for an unrelated phrase triggers a prune of the stale entry.
        c.recordMiss({ ...baseParams, text: "fresh" });

        const texts = readTexts();
        expect(texts).toContain("fresh");
        expect(texts).not.toContain("stale");
    });

    it("deletes the persisted audio file when an entry expires by audioTtlMs", () => {
        const c = new SayAudioCache({ dir, threshold: 1, ttlMs: 86_400_000, audioTtlMs: 86_400_000 });
        c.recordMiss({ ...baseParams, text: "audio-old" }, Buffer.from([1, 2, 3]), "audio/mpeg");
        expect(c.get({ ...baseParams, text: "audio-old" })).not.toBeNull();
        expect(readdirSync(dir).filter((f) => f.endsWith(".mp3")).length).toBe(1);

        backdateAllEntries(48 * 60 * 60 * 1000);
        c.recordMiss({ ...baseParams, text: "audio-new" });

        expect(c.get({ ...baseParams, text: "audio-old" })).toBeNull();
        expect(readdirSync(dir).filter((f) => f.endsWith(".mp3")).length).toBe(0);
    });

    it("never ttl-prunes persisted audio by default", () => {
        const c = new SayAudioCache({ dir, threshold: 1, ttlMs: 86_400_000 });
        c.recordMiss({ ...baseParams, text: "cached-phrase" }, Buffer.from([1, 2, 3]), "audio/mpeg");
        backdateAllEntries(365 * 24 * 60 * 60 * 1000); // a year old

        c.recordMiss({ ...baseParams, text: "other" });

        expect(c.get({ ...baseParams, text: "cached-phrase" })).not.toBeNull();
        expect(readdirSync(dir).filter((f) => f.endsWith(".mp3")).length).toBe(1);
    });

    it("keeps a frequently-used entry alive because each access refreshes lastUsed", () => {
        const c = new SayAudioCache({ dir, threshold: 5, ttlMs: 86_400_000 });
        c.recordMiss({ ...baseParams, text: "recurring" });
        backdateAllEntries(48 * 60 * 60 * 1000);

        // Re-saying the same phrase prunes it first, then re-creates it fresh
        // (count resets, but the phrase is not lost from the index).
        c.recordMiss({ ...baseParams, text: "recurring" });

        expect(readTexts()).toContain("recurring");
    });

    it("does not prune when ttlMs is disabled (<= 0)", () => {
        const c = new SayAudioCache({ dir, threshold: 5, ttlMs: 0 });
        c.recordMiss({ ...baseParams, text: "keep" });
        backdateAllEntries(365 * 24 * 60 * 60 * 1000); // a year old

        c.recordMiss({ ...baseParams, text: "another" });

        expect(readTexts()).toContain("keep");
    });

    it("writes index.json atomically and leaves no temp files behind", () => {
        const c = new SayAudioCache({ dir, threshold: 1 });
        c.recordMiss(baseParams, Buffer.from([1, 2]), "audio/mpeg");

        const stragglers = readdirSync(dir).filter((f) => f.endsWith(".tmp"));
        expect(stragglers).toEqual([]);

        // index.json itself is intact and parseable.
        const parsed = SafeJSON.parse(readFileSync(join(dir, "index.json"), "utf8")) as {
            version: number;
            entries: Record<string, unknown>;
        };
        expect(parsed.version).toBe(1);
        expect(Object.keys(parsed.entries).length).toBe(1);
    });
});
