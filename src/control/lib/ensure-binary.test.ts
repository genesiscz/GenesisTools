import { expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

const { ensureBinary, pinBinary, prunePinnedBinaries, REAL_AX_TOOL_IN_TESTS } = await import("./runner");

test("a pinned ax-tool is a content-named copy a later build cannot remove, reused while the build is the same", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pin-ax-tool-"));
    const root = join(dir, "pinned");
    const built = join(dir, "ax-tool");
    await Bun.write(built, "build one");

    const first = pinBinary(built, root);

    expect(first.startsWith(root)).toBe(true);
    expect(readFileSync(first, "utf8")).toBe("build one");
    expect(statSync(first).mode & 0o111).not.toBe(0);
    expect(pinBinary(built, root)).toBe(first);

    // A rebuild relinks the source; the pinned copy stays where the running recording found it.
    await Bun.write(built, "build two");
    const second = pinBinary(built, root);

    expect(second).not.toBe(first);
    expect(readFileSync(first, "utf8")).toBe("build one");
    expect(readFileSync(second, "utf8")).toBe("build two");
});

test("pruning keeps the newest three pinned copies and any used in the last three days", () => {
    const root = mkdtempSync(join(tmpdir(), "pin-prune-"));
    const now = Date.parse("2026-11-11T12:00:00.000Z");
    const ages = { a: 1, b: 10, c: 20, d: 30, e: 2 * 24 };

    for (const [name, hoursOld] of Object.entries(ages)) {
        mkdirSync(join(root, name));
        const at = new Date(now - hoursOld * 3600_000);
        utimesSync(join(root, name), at, at);
    }

    prunePinnedBinaries(root, now + 3 * 24 * 3600_000);

    expect(readdirSync(root).sort()).toEqual(["a", "b", "c"]);
    expect(existsSync(join(root, "e"))).toBe(false);
});

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
