import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The selftest is a standalone script so it can run from any checkout with plain `bun`.
// This wrapper is what puts it under `bun run test` and CI. The two variables keep it
// hermetic even if the lines inside selftest.ts that set them are ever moved.
describe("fable-replace selftest", () => {
    test("bun selftest.ts exits 0 and ends with ALL SELFTESTS PASSED", () => {
        const root = join(tmpdir(), "fable-replace");
        mkdirSync(root, { recursive: true });
        const scratch = mkdtempSync(join(root, "selftest-wrapper-"));
        try {
            const result = spawnSync("bun", [join(import.meta.dir, "selftest.ts")], {
                encoding: "utf8",
                env: { ...process.env, GENESIS_TOOLS_HOME: scratch, TMPDIR: scratch },
                timeout: 120_000,
            });
            if (result.status !== 0) {
                console.error(result.stdout);
                console.error(result.stderr);
            }
            expect(result.status).toBe(0);
            expect(result.stdout.trim().split("\n").at(-1)).toBe("ALL SELFTESTS PASSED");
        } finally {
            rmSync(scratch, { recursive: true, force: true });
        }
    });
});
