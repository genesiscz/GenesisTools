import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UsageDatabase } from "./UsageDatabase";

const dirs: string[] = [];

afterEach(() => {
    for (const dir of dirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
    }
});

// Regression test: #446 — `tools ask --help` wrote ~/.genesis-tools/ask.sqlite, because the
// module-level usage database opened its file at import time
describe("UsageDatabase", () => {
    it("creates no file until it is first used, then works", async () => {
        const dir = mkdtempSync(join(tmpdir(), "ask-usage-"));
        dirs.push(dir);
        const path = join(dir, "ask.sqlite");

        const db = new UsageDatabase(path);
        expect(existsSync(path)).toBe(false);

        expect(await db.getDailyUsage(7)).toEqual([]);
        expect(existsSync(path)).toBe(true);
    });
});
