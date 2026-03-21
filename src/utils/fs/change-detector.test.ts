import { describe, expect, test } from "bun:test";
import { defaultHash, detectChanges, detectChangesPreHashed } from "./change-detector";

describe("defaultHash", () => {
    test("returns consistent results for same input", () => {
        const hash1 = defaultHash("hello world");
        const hash2 = defaultHash("hello world");
        expect(hash1).toBe(hash2);
    });

    test("returns different results for different input", () => {
        const hash1 = defaultHash("hello");
        const hash2 = defaultHash("world");
        expect(hash1).not.toBe(hash2);
    });

    test("returns a hex string", () => {
        const hash = defaultHash("test");
        expect(hash).toMatch(/^[0-9a-f]+$/);
    });
});

describe("detectChanges", () => {
    test("empty previous -> all added", () => {
        const current = new Map([
            ["a.ts", "content-a"],
            ["b.ts", "content-b"],
        ]);
        const previous = new Map<string, string>();

        const result = detectChanges(current, previous);
        expect(result.added.sort()).toEqual(["a.ts", "b.ts"]);
        expect(result.modified).toEqual([]);
        expect(result.deleted).toEqual([]);
        expect(result.unchanged).toEqual([]);
    });

    test("identical content -> all unchanged", () => {
        const content = new Map([
            ["a.ts", "content-a"],
            ["b.ts", "content-b"],
        ]);

        // Build previous from hashes of the same content
        const previous = new Map<string, string>();

        for (const [path, c] of content) {
            previous.set(path, defaultHash(c));
        }

        const result = detectChanges(content, previous);
        expect(result.added).toEqual([]);
        expect(result.modified).toEqual([]);
        expect(result.deleted).toEqual([]);
        expect(result.unchanged.sort()).toEqual(["a.ts", "b.ts"]);
    });

    test("mixed: added, modified, deleted, unchanged", () => {
        const previous = new Map([
            ["unchanged.ts", defaultHash("same")],
            ["modified.ts", defaultHash("old-content")],
            ["deleted.ts", defaultHash("gone")],
        ]);

        const current = new Map([
            ["unchanged.ts", "same"],
            ["modified.ts", "new-content"],
            ["added.ts", "new-file"],
        ]);

        const result = detectChanges(current, previous);
        expect(result.added).toEqual(["added.ts"]);
        expect(result.modified).toEqual(["modified.ts"]);
        expect(result.deleted).toEqual(["deleted.ts"]);
        expect(result.unchanged).toEqual(["unchanged.ts"]);
    });

    test("custom hashFn is used", () => {
        // Custom hash that just returns the content as-is
        const customHash = (content: string) => content;
        const previous = new Map([["a.ts", "hash-a"]]);
        const current = new Map([["a.ts", "hash-a"]]);

        const result = detectChanges(current, previous, { hashFn: customHash });
        expect(result.unchanged).toEqual(["a.ts"]);
    });
});

describe("detectChangesPreHashed", () => {
    test("works with known hashes", () => {
        const previous = new Map([
            ["a.ts", "hash-111"],
            ["b.ts", "hash-222"],
            ["c.ts", "hash-333"],
        ]);

        const current = new Map([
            ["a.ts", "hash-111"],       // unchanged
            ["b.ts", "hash-modified"],   // modified
            ["d.ts", "hash-444"],        // added
        ]);

        const result = detectChangesPreHashed(current, previous);
        expect(result.unchanged).toEqual(["a.ts"]);
        expect(result.modified).toEqual(["b.ts"]);
        expect(result.added).toEqual(["d.ts"]);
        expect(result.deleted).toEqual(["c.ts"]);
    });

    test("empty both -> empty changeset", () => {
        const result = detectChangesPreHashed(new Map(), new Map());
        expect(result.added).toEqual([]);
        expect(result.modified).toEqual([]);
        expect(result.deleted).toEqual([]);
        expect(result.unchanged).toEqual([]);
    });
});
