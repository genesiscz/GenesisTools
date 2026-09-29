import { afterAll, expect, mock, test } from "bun:test";
import { mkdtempSync, readdirSync, renameSync, rmSync } from "node:fs";
import * as fsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

// A clear lands between two awaits of a write, which no public seam reaches: the hook runs right
// before the next pending file is opened, after that write has reserved its bytes.
let beforePendingOpen: (() => Promise<void>) | undefined;
const realOpen = fsPromises.open;
mock.module("node:fs/promises", () => ({
    ...fsPromises,
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

test("a clear while a write is in flight keeps each write's bytes in the directory that holds its file", async () => {
    const probe = createGrepCache({ directory: join(scratch, "probe") });
    await probe.put(entryInput(0), { q0: 0.7 });
    const size = Bun.file(
        join(scratch, "probe", "entries-v1", readdirSync(join(scratch, "probe", "entries-v1"))[0]!)
    ).size;
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
