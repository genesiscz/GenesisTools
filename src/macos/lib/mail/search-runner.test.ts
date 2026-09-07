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

    it("a stage that blocks the event loop past its deadline is still reported as a timeout, never a success", async () => {
        // Synchronous work (a SQLite query) cannot be interrupted, and the timer cannot fire while it runs.
        // The result must not slip through as a success once the stage finally returns.
        const stage = stageGuard(20);
        const blockFor = (ms: number) => {
            const until = performance.now() + ms;
            while (performance.now() < until) {
                // busy-wait: the timer callback stays queued the whole time
            }
        };

        await expect(
            stage("search.index.rows", async () => {
                blockFor(60);
                return "late";
            })
        ).rejects.toThrow(/timed out after 0s in stage "search.index.rows" \(deadline 0s\)/);
    });

    it("a stage that blocks but finishes inside the deadline passes", async () => {
        const stage = stageGuard(500);
        const until = performance.now() + 5;
        const value = await stage("search.index.rows", async () => {
            while (performance.now() < until) {
                // brief synchronous work
            }
            return "on time";
        });
        expect(value).toBe("on time");
    });
});

describe("vectorCapWarning", () => {
    it("is silent while the over-fetch stays under the sqlite-vec cap", () => {
        expect(vectorCapWarning(250, true, "rrf")).toBeUndefined();
        expect(vectorCapWarning(1000, false, "rrf")).toBeUndefined();
        expect(vectorCapWarning(800, true, "cosine")).toBeUndefined();
        expect(vectorCapWarning(4096, false, "cosine")).toBeUndefined();
    });

    it("hybrid: names the cap and the ask, says recall is reduced, and claims no rank boundary", () => {
        const warning = vectorCapWarning(500, true, "rrf");
        expect(warning).toContain(`capped at ${SQLITE_VEC_MAX_K}`);
        expect(warning).toContain("the hybrid search asked for 7500 for --limit 500");
        expect(warning).toContain("vector recall is reduced");
        expect(warning).toContain("fulltext and vector scores together");
        expect(warning).not.toMatch(/past about|ranked by fulltext matches only/);
        expect(vectorCapWarning(2000, false, "rrf")).toContain("asked for 6000");
    });

    it("vector-only: no RRF pool factor, and the message speaks of nearest neighbours, not fulltext ranking", () => {
        // 5x filtered over-fetch only: 1000 * 5 = 5000 > 4096.
        const warning = vectorCapWarning(1000, true, "cosine");
        expect(warning).toContain("the vector search asked for 5000 for --limit 1000");
        expect(warning).toContain(`only the ${SQLITE_VEC_MAX_K} nearest neighbours`);
        expect(warning).not.toContain("fulltext");
        // Unfiltered cosine asks exactly the page: 4097 is the first size that trips the cap.
        expect(vectorCapWarning(4097, false, "cosine")).toContain("asked for 4097");
    });
});
