import { expect, mock, test } from "bun:test";
import { env } from "@genesiscz/utils/env";

/**
 * `ensureBinary` runs before every `runAx`, so the freshness check it delegates to is on the
 * hot path of every `see`, `act` and `cursor` call. It re-hashes every Swift source and the
 * whole binary to answer, which is why the verdict is memoized per process. This pins that:
 * the check is consulted once, however many commands the process issues.
 */

let needsBuildCalls = 0;

mock.module("./native-build", () => ({
    nativeNeedsBuild: () => {
        needsBuildCalls++;
        return false;
    },
    // Mocking a module replaces ALL of its exports, and runner.ts imports this one as well.
    NATIVE_BUILD_WORKER_TIMEOUT_MS: 1,
}));

const { ensureBinary, REAL_AX_TOOL_IN_TESTS } = await import("./runner");

test("the native freshness check is consulted once per process, not once per command", async () => {
    // Under test ensureBinary refuses to hand out the real binary. This test spawns nothing and
    // builds nothing (native-build is mocked above), so it opts in to reach the memo it pins.
    await env.testing.withOverrides({ [REAL_AX_TOOL_IN_TESTS]: "1" }, () => {
        const first = ensureBinary();

        for (let call = 0; call < 20; call++) {
            expect(ensureBinary()).toBe(first);
        }
    });

    expect(needsBuildCalls).toBe(1);
});
