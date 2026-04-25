import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isFdAvailable, parseTmutilOutput } from "@app/doctor/analyzers/disk-space";

const FIXTURES = join(import.meta.dir, "fixtures");

describe("parseTmutilOutput", () => {
    it("returns empty array for empty snapshot list", () => {
        const raw = readFileSync(join(FIXTURES, "tmutil-empty.txt"), "utf8");
        expect(parseTmutilOutput(raw)).toEqual([]);
    });

    it("parses snapshot names", () => {
        const raw = readFileSync(join(FIXTURES, "tmutil-with-snapshots.txt"), "utf8");
        const snapshots = parseTmutilOutput(raw);
        expect(snapshots).toHaveLength(3);
        expect(snapshots[0]).toBe("com.apple.TimeMachine.2026-04-15-080000.local");
    });
});

describe("isFdAvailable", () => {
    it("returns boolean", async () => {
        expect(typeof (await isFdAvailable())).toBe("boolean");
    });
});
