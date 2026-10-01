import { describe, expect, it } from "bun:test";
import { Command } from "commander";
import { cached, capMaxCacheAge, maxCacheAgeOption, resolveMaxCacheAge } from "./cache-flag";
import type { Storage } from "./storage";

/** In-memory `getCacheFile` / `putCacheFile`; an entry's age is set by hand. */
function memoryStorage() {
    const entries = new Map<string, { value: unknown; ageSeconds: number }>();
    const reads: string[] = [];
    const storage: Pick<Storage, "getCacheFile" | "putCacheFile"> = {
        getCacheFile: async <T>(key: string, ttl: string): Promise<T | null> => {
            reads.push(ttl);
            const entry = entries.get(key);
            const seconds = Number(ttl.split(" ")[0]);
            return entry && entry.ageSeconds <= seconds ? (entry.value as T) : null;
        },
        putCacheFile: async <T>(key: string, value: T): Promise<void> => {
            entries.set(key, { value, ageSeconds: 0 });
        },
    };
    return { storage, entries, reads };
}

describe("cached", () => {
    it("fetches by default and still writes, so a later max age can use the answer", async () => {
        const { storage, entries, reads } = memoryStorage();
        let calls = 0;
        const fetch = async () => ++calls;

        expect(await cached({ storage, key: "k", fetch })).toEqual({ value: 1, hit: false });
        expect(await cached({ storage, key: "k", maxAgeSeconds: 0, fetch })).toEqual({ value: 2, hit: false });
        expect(reads).toEqual([]);
        expect(entries.get("k")?.value).toBe(2);

        entries.set("k", { value: 2, ageSeconds: 30 });
        expect(await cached({ storage, key: "k", maxAgeSeconds: 60, fetch })).toEqual({ value: 2, hit: true });
        expect(await cached({ storage, key: "k", maxAgeSeconds: 10, fetch })).toEqual({ value: 3, hit: false });
        expect(calls).toBe(3);
    });

    it("returns the fetched value when the cache write fails", async () => {
        const storage: Pick<Storage, "getCacheFile" | "putCacheFile"> = {
            getCacheFile: async () => null,
            putCacheFile: async () => {
                throw new Error("ENOSPC: no space left on device");
            },
        };

        expect(await cached({ storage, key: "k", fetch: async () => "log" })).toEqual({ value: "log", hit: false });
    });

    it("refetches a hit that fails isValid, and keeps what shouldStore refuses out of the cache", async () => {
        const { storage, entries } = memoryStorage();
        entries.set("k", { value: { head: "a" }, ageSeconds: 1 });

        const moved = await cached({
            storage,
            key: "k",
            maxAgeSeconds: 60,
            fetch: async () => ({ head: "b" }),
            isValid: (hit) => hit.head === "b",
        });
        expect(moved).toEqual({ value: { head: "b" }, hit: false });

        await cached({ storage, key: "k2", fetch: async () => "running", shouldStore: (value) => value === "done" });
        expect(entries.has("k2")).toBe(false);
    });
});

describe("--max-cache-age", () => {
    const parse = (argv: string[]) => {
        const command = new Command().exitOverride().addOption(maxCacheAgeOption()).option("--fresh");
        command.parse(argv, { from: "user" });
        return command.opts<{ maxCacheAge?: number; fresh?: boolean }>();
    };

    it("parses whole seconds, and --fresh wins over it", () => {
        expect(parse(["--max-cache-age", "300"]).maxCacheAge).toBe(300);
        expect(resolveMaxCacheAge(parse([]))).toBe(0);
        expect(resolveMaxCacheAge(parse(["--max-cache-age", "30"]))).toBe(30);
        expect(resolveMaxCacheAge(parse(["--max-cache-age", "30", "--fresh"]))).toBe(0);
    });

    it("refuses a negative, fractional or empty value", () => {
        for (const bad of ["-1", "1.5", "", "soon"]) {
            expect(() => parse(["--max-cache-age", bad])).toThrow();
        }
    });

    it("caps at the cache's own rule", () => {
        expect(capMaxCacheAge(undefined, 60)).toBe(60);
        expect(capMaxCacheAge(600, 60)).toBe(60);
        expect(capMaxCacheAge(0, 60)).toBe(0);
    });
});
