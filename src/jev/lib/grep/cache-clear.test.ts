import { afterAll, expect, mock, test } from "bun:test";
import { mkdtempSync, readdirSync, renameSync, rmSync } from "node:fs";
import * as fsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

// A clear lands between two awaits of a write, which no public seam reaches: the hook runs right
// before the next pending file is opened, after that write has reserved its bytes.
let beforePendingOpen: (() => Promise<void>) | undefined;
let afterEntryMeasure: (() => Promise<void>) | undefined;
const realOpen = fsPromises.open;
const realLstat = fsPromises.lstat;
mock.module("node:fs/promises", () => ({
    ...fsPromises,
    lstat: async (...args: Parameters<typeof realLstat>) => {
        const result = await realLstat(...args);
        const hook = /^[a-f0-9]{64}\.json$/.test(basename(String(args[0]))) ? afterEntryMeasure : undefined;
        if (hook) {
            afterEntryMeasure = undefined;
            await hook();
        }

        return result;
    },
    open: async (...args: Parameters<typeof realOpen>) => {
        const hook = basename(String(args[0])).startsWith(".pending-") ? beforePendingOpen : undefined;
        if (hook) {
            beforePendingOpen = undefined;
            await hook();
        }

        return realOpen(...args);
    },
}));
const { createGrepCache } = await import("./cache");

const scratch = mkdtempSync(join(tmpdir(), "jev-grep-cache-clear-"));
afterAll(() => {
    rmSync(scratch, { recursive: true, force: true });
});

const namespace = { provider: "fixture", model: "fixture", policyVersion: "1", promptVersion: "1" };
const entryInput = (index: number) => ({
    namespace,
    sources: [],
    request: { state: { query: `q${index}` }, questions: {} },
});

async function entrySize(): Promise<number> {
    const probe = join(scratch, "probe");
    await createGrepCache({ directory: probe }).put(entryInput(0), { q0: 0.7 });
    return Bun.file(join(probe, "entries-v1", readdirSync(join(probe, "entries-v1"))[0]!)).size;
}

test("a clear while a write is in flight keeps each write's bytes in the directory that holds its file", async () => {
    const size = await entrySize();
    const directory = join(scratch, "grep-cache");
    const entries = join(directory, "entries-v1");
    const cache = createGrepCache({ directory, maxBytes: Math.floor(size * 2.5) });
    // Write 1 reserves in the first directory. A clear detaches it, write 2 recreates the directory and
    // stores its entry, and only then does write 1 open its pending file, in the new directory.
    beforePendingOpen = async () => {
        renameSync(entries, join(directory, ".cleared-fixture"));
        await cache.put(entryInput(2), { q0: 0.7 });
    };
    await cache.put(entryInput(1), { q0: 0.7 });
    expect(readdirSync(entries).length).toBe(2);
    await cache.put(entryInput(3), { q0: 0.7 });
    expect(readdirSync(entries).length).toBe(2);
    expect(cache.stats().warnings).toEqual([{ kind: "cache_limit", count: 1 }]);
});
test("a clear while a rewrite measures its old entry does not count that entry against the new directory", async () => {
    const size = await entrySize();
    const directory = join(scratch, "grep-cache-measure");
    const entries = join(directory, "entries-v1");
    const cache = createGrepCache({ directory, maxBytes: Math.floor(size * 2.5) });
    await cache.put(entryInput(1), { q0: 0.7 });
    // The rewrite of entry 1 measures its copy in the first directory. Right after, a clear detaches
    // that directory and write 2 stores its entry in a new one, before the rewrite reserves anything.
    afterEntryMeasure = async () => {
        renameSync(entries, join(directory, ".cleared-fixture"));
        await cache.put(entryInput(2), { q0: 0.7 });
    };
    await cache.put(entryInput(1), { q0: 0.7 });
    expect(readdirSync(entries).length).toBe(2);
    await cache.put(entryInput(3), { q0: 0.7 });
    expect(readdirSync(entries).length).toBe(2);
    expect(cache.stats().warnings).toEqual([{ kind: "cache_limit", count: 1 }]);
});
