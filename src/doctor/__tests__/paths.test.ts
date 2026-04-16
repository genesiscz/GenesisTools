import { describe, expect, it } from "bun:test";
import { homedir } from "node:os";
import { DOCTOR_DIR, analysisDirFor, cacheFilePath, makeRunId } from "@app/doctor/lib/paths";

describe("paths", () => {
    it("DOCTOR_DIR lives under ~/.genesis-tools/doctor", () => {
        expect(DOCTOR_DIR).toBe(`${homedir()}/.genesis-tools/doctor`);
    });

    it("analysisDirFor uses runId as subdir", () => {
        expect(analysisDirFor("2026-04-17T14-30-12")).toBe(
            `${homedir()}/.genesis-tools/doctor/analysis/2026-04-17T14-30-12`
        );
    });

    it("cacheFilePath joins analyzer id", () => {
        expect(cacheFilePath("disk-space")).toBe(`${homedir()}/.genesis-tools/doctor/cache/disk-space.json`);
    });

    it("makeRunId replaces colons with dashes", () => {
        const id = makeRunId(new Date("2026-04-17T14:30:12.000Z"));
        expect(id).toBe("2026-04-17T14-30-12");
    });
});
