import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { guardReason } from "@genesiscz/utils/storage/real-home-guard";
import { isTestProcess, TEST_RUNTIME_FLAG, testProcessReason } from "@genesiscz/utils/test-process";

const HOME = "GENESIS_TOOLS_HOME";

afterEach(() => {
    env.testing.unset("NODE_ENV");
    env.testing.set("NODE_ENV", "test");
});

describe("testProcessReason", () => {
    test("says why, not just yes", () => {
        expect(isTestProcess()).toBe(true);
        expect(testProcessReason()).toBeTypeOf("string");
    });

    test("NODE_ENV is only the first signal, never the only one", async () => {
        // 🛑 The whole point. `bun test` sets NODE_ENV only when it is not already set
        // (oven-sh/bun#4118), so a parent exporting NODE_ENV=development used to turn every
        // guard in this repo off. Measured 2026-09-22 with a real agent process doing exactly
        // that. The other two signals have to carry it.
        await env.testing.withOverrides({ NODE_ENV: "development" }, () => {
            expect(isTestProcess()).toBe(true);
            expect(testProcessReason()).not.toBe("NODE_ENV=test");
        });
    });

    test("the preload flag alone is enough, so a spawned child is still covered", async () => {
        // A subprocess inherits the environment but gets its own `Bun.main`, so this flag is
        // the only signal that reaches it.
        await env.testing.withOverrides({ NODE_ENV: "production", [TEST_RUNTIME_FLAG]: "1" }, () => {
            expect(testProcessReason("/srv/app/worker.ts")).toContain(TEST_RUNTIME_FLAG);
        });
    });
});

describe("guardReason", () => {
    test("an installed sandbox arms the guard with no process detection at all", async () => {
        const sandbox = mkdtempSync(join(tmpdir(), "guard-reason-"));

        await env.testing.withOverrides(
            { NODE_ENV: "production", [TEST_RUNTIME_FLAG]: undefined, [HOME]: sandbox },
            () => {
                // Every process signal is off, and the guard is still armed, because a sandbox
                // home is installed and the real store is therefore out of bounds.
                expect(testProcessReason("/srv/app/worker.ts")).toBe(null);
                expect(guardReason("/srv/app/worker.ts")).toContain("sandbox");
            }
        );
    });

    test("a GENESIS_TOOLS_HOME equal to the real home is not a sandbox", async () => {
        await env.testing.withOverrides(
            { NODE_ENV: "production", [TEST_RUNTIME_FLAG]: undefined, [HOME]: homedir() },
            () => {
                expect(guardReason("/srv/app/worker.ts")).toBe(null);
            }
        );
    });

    test("production is untouched: no sandbox, no test file, no flag", async () => {
        await env.testing.withOverrides(
            { NODE_ENV: "production", [TEST_RUNTIME_FLAG]: undefined, [HOME]: undefined },
            () => {
                // `Bun.main` is this test file, a signal a real user's `tools` binary never has,
                // so the whole verdict is asked with a production entrypoint in its place.
                expect(env.tools.hasExplicitHome()).toBe(false);
                expect(env.isFlag(TEST_RUNTIME_FLAG)).toBe(false);
                expect(env.get("NODE_ENV")).toBe("production");
                expect(guardReason("/srv/app/worker.ts")).toBe(null);
            }
        );
    });
});
