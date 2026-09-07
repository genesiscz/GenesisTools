import { describe, expect, it } from "bun:test";
import { SQLITE_VEC_MAX_K } from "@genesiscz/utils/search/stores/sqlite-vec-store";
import { stageGuard, vectorCapWarning } from "./search-runner";

describe("stageGuard", () => {
    it("rejects a stage that never settles, naming the stage", async () => {
        const stage = stageGuard(30);
        const never = new Promise<number>(() => {});
        const t0 = performance.now();

        await expect(stage("search.index.hybrid", () => never)).rejects.toThrow(
            /timed out after 0s in stage "search.index.hybrid".*--timeout/
        );
        expect(performance.now() - t0).toBeLessThan(1000);
    });

    it("passes a settling stage through untouched and clears its timer", async () => {
        const stage = stageGuard(30);
        const value = await stage("search.attachments", async () => 42);
        expect(value).toBe(42);
        await Bun.sleep(40);
    });

    it("propagates the stage's own error", async () => {
        const stage = stageGuard(1000);
        await expect(stage("search.index.rows", () => Promise.reject(new Error("locked")))).rejects.toThrow("locked");
    });
});

describe("vectorCapWarning", () => {
    it("is silent while the hybrid over-fetch stays under the sqlite-vec cap", () => {
        expect(vectorCapWarning(250, true)).toBeUndefined();
        expect(vectorCapWarning(1000, false)).toBeUndefined();
    });

    it("names the cap, the ask and the covered rank once the over-fetch exceeds it", () => {
        const warning = vectorCapWarning(500, true);
        expect(warning).toContain(`capped at ${SQLITE_VEC_MAX_K}`);
        expect(warning).toContain("asked for 7500 for --limit 500");
        expect(warning).toContain("past about 273");
        expect(vectorCapWarning(2000, false)).toContain("asked for 6000");
    });
});
