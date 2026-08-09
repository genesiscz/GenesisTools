import { describe, expect, it } from "bun:test";
import { analysisDirFor, cacheFilePath, DOCTOR_DIR, makeRunId } from "@app/doctor/lib/paths";
import { env } from "@genesiscz/utils/env";
import { toPosixPath } from "@genesiscz/utils/paths";

// Not `homedir()`: the paths follow GENESIS_TOOLS_HOME, which the test preload
// points at a tmp sandbox. Pinning the real home here asserted the bug.
const HOME = toPosixPath(env.tools.getHome());

describe("paths", () => {
    it("DOCTOR_DIR lives under ~/.genesis-tools/doctor", () => {
        expect(DOCTOR_DIR).toBe(`${HOME}/.genesis-tools/doctor`);
    });

    it("analysisDirFor uses runId as subdir", () => {
        expect(analysisDirFor("2026-04-17T14-30-12")).toBe(
            `${HOME}/.genesis-tools/doctor/analysis/2026-04-17T14-30-12`
        );
    });

    it("cacheFilePath joins analyzer id", () => {
        expect(cacheFilePath("disk-space")).toBe(`${HOME}/.genesis-tools/doctor/cache/disk-space.json`);
    });

    it("makeRunId replaces colons and dots with dashes (millisecond precision)", () => {
        const id = makeRunId(new Date("2026-04-17T14:30:12.345Z"));
        expect(id).toBe("2026-04-17T14-30-12-345Z");
    });
});
