import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { GOLDEN_CASES, goldenPath, runGoldenCase, writeGoldenHome } from "./__tests__/golden-home";

/**
 * The bytes of `tools ai-spend daily`, `weekly` and `statusline` (Claude Code runs the statusline in its settings,
 * and scripts read the JSON). Pinned before the spend library moved into `@genesiscz/utils/ai/usage/spend`.
 * Every case runs in parallel, one child process each, against one fixture home. `tools ai usage spend` is an alias
 * of the same tree, so each case also runs through it and must print the same bytes.
 */

const DOORS = [
    { door: "tools ai-spend", entrypoint: "ai-spend", prefix: [] },
    { door: "tools ai usage spend", entrypoint: "ai", prefix: ["usage", "spend"] },
] as const;

describe("tools ai-spend keeps its bytes (golden)", () => {
    const home = writeGoldenHome();

    test("daily, weekly and statusline print the pinned bytes through both doors", async () => {
        const runs = await Promise.all(
            DOORS.flatMap(({ door, entrypoint, prefix }) =>
                GOLDEN_CASES.map(async (golden) => ({
                    name: `${door} ${golden.name}`,
                    golden: golden.name,
                    run: await runGoldenCase({ home, entrypoint, prefix: [...prefix], golden }),
                }))
            )
        );

        for (const { name, golden, run } of runs) {
            expect({ name, code: run.code }).toEqual({ name, code: 0 });
            expect({ name, stdout: run.stdout }).toEqual({ name, stdout: readFileSync(goldenPath(golden), "utf8") });
        }
    }, 60_000);
});
