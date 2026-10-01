import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { liveIdbMtimeMs } from "./snapshot";

describe("liveIdbMtimeMs", () => {
    it("sees a write to the leveldb .log even when CURRENT is older", () => {
        const dir = mkdtempSync(join(tmpdir(), "ms-teams-idb-"));

        try {
            const current = join(dir, "CURRENT");
            const wal = join(dir, "000204.log");
            writeFileSync(current, "MANIFEST-000001\n");
            writeFileSync(wal, "new messages");
            utimesSync(current, new Date("2026-06-01T08:00:00Z"), new Date("2026-06-01T08:00:00Z"));
            utimesSync(wal, new Date("2026-06-01T10:00:00Z"), new Date("2026-06-01T10:00:00Z"));
            utimesSync(dir, new Date("2026-06-01T09:00:00Z"), new Date("2026-06-01T09:00:00Z"));

            expect(liveIdbMtimeMs(dir)).toBe(Date.parse("2026-06-01T10:00:00Z"));
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("returns 0 for a missing directory", () => {
        expect(liveIdbMtimeMs(join(tmpdir(), "ms-teams-idb-missing-dir"))).toBe(0);
    });
});
