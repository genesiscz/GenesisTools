import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { GOLDEN_CASES, goldenPath, runGoldenCase, writeGoldenHome } from "./__tests__/golden-home";

/**
 * The bytes of `tools ai-spend daily`, `weekly` and `statusline` (Claude Code runs the statusline in its settings,
 * and scripts read the JSON). Pinned before the spend library moved into `@genesiscz/utils/ai/usage/spend`.
 * Every case runs in parallel, one child process each, against one fixture home.
 */

describe("tools ai-spend keeps its bytes (golden)", () => {
    const home = writeGoldenHome();

    test("daily, weekly and statusline print the pinned bytes", async () => {
        const runs = await Promise.all(
            GOLDEN_CASES.map(async (golden) => ({
                name: golden.name,
                run: await runGoldenCase({ home, entrypoint: "ai-spend", golden }),
            }))
        );

        for (const { name, run } of runs) {
            expect({ name, code: run.code }).toEqual({ name, code: 0 });
            expect({ name, stdout: run.stdout }).toEqual({ name, stdout: readFileSync(goldenPath(name), "utf8") });
        }
    }, 60_000);
});
