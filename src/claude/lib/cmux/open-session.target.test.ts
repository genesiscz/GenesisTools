import { beforeEach, describe, expect, mock, test } from "bun:test";

/**
 * The ARGV `livePlacementIO` builds, not the order it calls things in.
 *
 * `open-session.test.ts` injects a fake `PlacementIO`, so it proves the
 * select/sleep/send/raise sequence but never sees a single flag. That blind spot
 * is exactly where this bug lives: master's `885c4454d` removed `--workspace`
 * from surface sends because a stale workspace makes cmux answer
 * `invalid_params: Surface is not a terminal` about a perfectly good terminal,
 * and `raiseThenSend` re-introduced an unconditional `--workspace` when it took
 * over the call site. A test that only asserts "send was called" passes on the
 * broken version, so these assert the flags.
 *
 * Separate file, and the module is imported dynamically, because `mock.module`
 * only takes effect for imports resolved AFTER it runs — a static import at the
 * top of `open-session.test.ts` would already hold the real cli binding.
 */
const argv: string[][] = [];

mock.module("@genesiscz/utils/cmux/lib/cli", () => ({
    runCmuxOk: async (args: string[]) => {
        argv.push(args);
        return { code: 0, stdout: "", stderr: "" };
    },
    runCmuxJSON: async (args: string[]) => {
        argv.push(args);
        return { caller: { window_ref: "window:1" } };
    },
    runCmux: async (args: string[]) => {
        argv.push(args);
        return { code: 0, stdout: "", stderr: "" };
    },
}));

const { livePlacementIO } = await import("./open-session");

/** The argv of the one `send` invocation. */
function sendArgs(): string[] {
    const sends = argv.filter((a) => a[0] === "send");
    expect(sends).toHaveLength(1);
    return sends[0];
}

const WORKSPACE = "workspace:12";
const SURFACE_UUID = "22222222-2222-4222-8222-222222222222";

beforeEach(() => {
    argv.length = 0;
});

describe("livePlacementIO().send target flags", () => {
    test("a surface UUID is sent WITHOUT --workspace, so a stale one cannot scope it away", async () => {
        // The regression guard. Before this fix the argv was
        // ["send", "--workspace", WORKSPACE, "--surface", SURFACE_UUID, payload].
        await livePlacementIO().send(WORKSPACE, SURFACE_UUID, "cmd\n");

        const args = sendArgs();
        expect(args).not.toContain("--workspace");
        expect(args).not.toContain(WORKSPACE);
        expect(args).toEqual(["send", "--surface", SURFACE_UUID, "cmd\n"]);
    });

    test("a surface: ref is self-identifying too, so it also drops the workspace", async () => {
        await livePlacementIO().send(WORKSPACE, "surface:44", "cmd\n");

        expect(sendArgs()).toEqual(["send", "--surface", "surface:44", "cmd\n"]);
    });

    test("a tab: ref likewise", async () => {
        await livePlacementIO().send(WORKSPACE, "tab:3", "cmd\n");

        expect(sendArgs()).toEqual(["send", "--surface", "tab:3", "cmd\n"]);
    });

    test("NEGATIVE CONTROL: a bare index IS workspace-relative and KEEPS --workspace", async () => {
        // Without this, dropping the flag unconditionally would pass every test
        // above while breaking every send that names a surface by index.
        await livePlacementIO().send(WORKSPACE, "4", "cmd\n");

        const args = sendArgs();
        expect(args).toContain("--workspace");
        expect(args).toEqual(["send", "--workspace", WORKSPACE, "--surface", "4", "cmd\n"]);
    });

    test("selectWorkspace still names the workspace — it is a workspace command, not a surface send", async () => {
        // The fix must not strip --workspace from commands that are genuinely
        // workspace-scoped; only the surface send is self-identifying.
        await livePlacementIO().selectWorkspace(WORKSPACE);

        expect(argv).toEqual([["select-workspace", "--workspace", WORKSPACE]]);
    });
});
