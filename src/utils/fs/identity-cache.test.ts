import { afterAll, describe, expect, it } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { FileIdentityCache, fileIdentity } from "./identity-cache";

const dir = mkdtempSync(join(tmpdir(), "identity-cache-"));

afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
});

function isText(value: unknown): value is string {
    return typeof value === "string";
}

function cacheAt(path: string, version = 1): FileIdentityCache<string> {
    return new FileIdentityCache<string>({ limit: 10, persist: { path: () => path, version, isValue: isText } });
}

describe("FileIdentityCache", () => {
    it("serves a value only while the file keeps the identity it was computed for", async () => {
        const file = join(dir, "grows.jsonl");
        writeFileSync(file, "one\n");
        const cache = new FileIdentityCache<string>({ limit: 10 });
        const before = await fileIdentity(file);

        expect(before).not.toBeNull();
        cache.set(file, before ?? { ino: 0, size: 0, mtimeMs: 0, ctimeMs: 0 }, "parsed one");

        expect(cache.get(file, await fileIdentity(file))).toBe("parsed one");

        appendFileSync(file, "two\n");

        expect(cache.get(file, await fileIdentity(file))).toBeUndefined();
        expect(cache.get(join(dir, "never-written"), await fileIdentity(join(dir, "never-written")))).toBeUndefined();
    });

    it("drops the oldest entry past its limit", () => {
        const cache = new FileIdentityCache<string>({ limit: 2 });
        const identity = { ino: 1, size: 1, mtimeMs: 1, ctimeMs: 1 };
        cache.set("a", identity, "A");
        cache.set("b", identity, "B");
        cache.set("c", identity, "C");

        expect([cache.get("a", identity), cache.get("b", identity), cache.get("c", identity)]).toEqual([
            undefined,
            "B",
            "C",
        ]);
    });

    it("hands its entries to a new process through the saved file, and ignores another version", async () => {
        const saved = join(dir, "cache", "saved.json");
        const identity = { ino: 7, size: 3, mtimeMs: 10, ctimeMs: 11 };
        const writer = cacheAt(saved);
        await writer.load();
        writer.set("/x.jsonl", identity, "header of x");
        await writer.save();

        const reader = cacheAt(saved);
        await reader.load();
        expect(reader.get("/x.jsonl", identity)).toBe("header of x");
        expect(reader.get("/x.jsonl", { ...identity, ctimeMs: 12 })).toBeUndefined();

        const newer = cacheAt(saved, 2);
        await newer.load();
        expect(newer.get("/x.jsonl", identity)).toBeUndefined();
    });

    it("drops a saved entry whose value fails the check", async () => {
        const saved = join(dir, "bad.json");
        const identity = { ino: 1, size: 1, mtimeMs: 1, ctimeMs: 1 };
        writeFileSync(
            saved,
            SafeJSON.stringify({ version: 1, entries: { "/y": { identity, value: 42 } } }, { strict: true })
        );
        const cache = cacheAt(saved);
        await cache.load();

        expect(cache.get("/y", identity)).toBeUndefined();
    });
});
