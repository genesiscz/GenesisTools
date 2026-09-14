import { expect, mock, test } from "bun:test";

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
    // Mocking a module replaces ALL of its exports, and runner.ts imports these two as well.
    captureNativeSources: () => ({ files: [], fingerprint: "fixture" }),
    recordNativeBuild: () => {},
}));

const { ensureBinary } = await import("./runner");

test("the native freshness check is consulted once per process, not once per command", () => {
    const first = ensureBinary();

    for (let call = 0; call < 20; call++) {
        expect(ensureBinary()).toBe(first);
    }

    expect(needsBuildCalls).toBe(1);
});
