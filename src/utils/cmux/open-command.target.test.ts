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

const WINDOW = "0B000000-0000-4000-8000-000000000001";
const WORKSPACE = "11111111-1111-4111-8111-111111111112";
const SURFACE_UUID = "22222222-2222-4222-8222-222222222222";

mock.module("@genesiscz/utils/cmux/lib/cli", () => ({
    runCmuxOk: async (args: string[]) => {
        argv.push(args);
        return { code: 0, stdout: "", stderr: "" };
    },
    runCmuxJSON: async (args: string[]) => {
        argv.push(args);

        if (args[0] === "workspace" && args[1] === "create") {
            return {
                workspace_id: WORKSPACE,
                workspace_ref: "workspace:2",
                window_id: WINDOW,
                window_ref: "window:1",
                surface_id: SURFACE_UUID,
            };
        }

        if (args.includes("new-surface")) {
            return { surface_id: SURFACE_UUID };
        }

        return {
            caller: { window_id: WINDOW, window_ref: "window:1" },
            focused: { workspace_id: "99999999-9999-4999-8999-999999999999" },
        };
    },
    runCmux: async (args: string[]) => {
        argv.push(args);
        return { code: 0, stdout: "", stderr: "" };
    },
}));

const { livePlacementIO, openCommandAt } = await import("./open-command");

/** The argv of the one `paste` invocation: the launch line is pasted, so cmux reads no backslash in it as a key. */
function sendArgs(): string[] {
    const pastes = argv.filter((a) => a[0] === "paste");
    expect(pastes).toHaveLength(1);
    expect(argv.some((a) => a[0] === "send")).toBe(false);
    return pastes[0];
}

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
        expect(args).toEqual(["paste", "--surface", SURFACE_UUID, "--", "cmd"]);
        // The trailing newline is not pasted: it is pressed as Enter after the line.
        expect(argv.at(-1)).toEqual(["send-key", "--surface", SURFACE_UUID, "enter"]);
    });

    test("a launch line with a backslash and a quote is pasted as written, never typed", async () => {
        // shellQuote writes 'it'\''s', and `cmux send` reads a backslash sequence as a key.
        const line = "claude 'it'\\''s' 'C:\\new\\tab'";
        await livePlacementIO().send(WORKSPACE, SURFACE_UUID, `${line}\n`);

        expect(sendArgs()).toEqual(["paste", "--surface", SURFACE_UUID, "--", line]);
    });

    test("a surface: ref is self-identifying too, so it also drops the workspace", async () => {
        await livePlacementIO().send(WORKSPACE, "surface:44", "cmd\n");

        expect(sendArgs()).toEqual(["paste", "--surface", "surface:44", "--", "cmd"]);
    });

    test("a tab: ref likewise", async () => {
        await livePlacementIO().send(WORKSPACE, "tab:3", "cmd\n");

        expect(sendArgs()).toEqual(["paste", "--surface", "tab:3", "--", "cmd"]);
    });

    test("NEGATIVE CONTROL: a bare index IS workspace-relative and KEEPS --workspace", async () => {
        // Without this, dropping the flag unconditionally would pass every test
        // above while breaking every send that names a surface by index.
        await livePlacementIO().send(WORKSPACE, "4", "cmd\n");

        const args = sendArgs();
        expect(args).toContain("--workspace");
        expect(args).toEqual(["paste", "--workspace", WORKSPACE, "--surface", "4", "--", "cmd"]);
    });

    test("selectWorkspace still names the workspace — it is a workspace command, not a surface send", async () => {
        // The fix must not strip --workspace from commands that are genuinely
        // workspace-scoped; only the surface send is self-identifying.
        await livePlacementIO().selectWorkspace(WORKSPACE);

        expect(argv).toEqual([["select-workspace", "--workspace", WORKSPACE]]);
    });
});

// Session 0eafc38e's probes went through openCommandAt and switched Martin's view three times (2026-10-15).
describe("openCommandAt silent", () => {
    const PANE = "33333333-3333-4333-8333-333333333303";
    const changesView = (args: string[]) => ["select-workspace", "focus-window"].includes(args[0] ?? "");

    test("a silent tab is created, named and typed into without selecting, focusing or raising anything", async () => {
        const placed = await openCommandAt({
            command: "echo probe",
            target: { kind: "pane", workspaceId: WORKSPACE, paneId: PANE },
            title: "probe",
            silent: true,
        });

        expect(placed).toEqual({ workspaceId: WORKSPACE, surfaceId: SURFACE_UUID });
        expect(argv.filter(changesView)).toEqual([]);
        expect(sendArgs()).toContain("echo probe");
    });

    test.each([undefined, "/repo/fixture"])(
        "a silent workspace starts its command at creation (cwd %j)",
        async (cwd) => {
            const placed = await openCommandAt({
                command: "echo 'probe command'",
                target: { kind: "window", windowId: WINDOW },
                title: "probe",
                workspaceName: "fixture",
                cwd,
                silent: true,
            });

            expect(placed).toEqual({ workspaceId: WORKSPACE, surfaceId: SURFACE_UUID });
            const creates = argv.filter((args) => args[0] === "workspace" && args[1] === "create");
            expect(creates).toEqual([
                [
                    "workspace",
                    "create",
                    "--window",
                    WINDOW,
                    "--cwd",
                    cwd ?? process.cwd(),
                    "--focus",
                    "false",
                    "--command",
                    "echo 'probe command'",
                    "--name",
                    "fixture",
                ],
            ]);
            expect(argv.some((args) => args[0] === "send" || args[0] === "paste")).toBe(false);
            expect(argv.filter(changesView)).toEqual([]);
            expect(argv).toContainEqual(["workspace", "rename", WORKSPACE, "--title", "fixture"]);
        }
    );

    test.each([true, false])("a silent existing surface still sends, with enter %j", async (enter) => {
        const placed = await openCommandAt({
            command: "echo probe",
            target: { kind: "surface", workspaceId: WORKSPACE, surfaceId: SURFACE_UUID },
            title: "probe",
            silent: true,
            enter,
        });

        expect(placed).toEqual({ workspaceId: WORKSPACE, surfaceId: SURFACE_UUID });
        expect(argv).toEqual([
            ["paste", "--surface", SURFACE_UUID, "--", "echo probe"],
            ...(enter ? [["send-key", "--surface", SURFACE_UUID, "enter"]] : []),
        ]);
    });

    test("a silent new workspace refuses enter:false before creating anything", async () => {
        await expect(
            openCommandAt({
                command: "echo probe",
                target: { kind: "window", windowId: WINDOW },
                title: "probe",
                silent: true,
                enter: false,
            })
        ).rejects.toThrow("cmux cannot type without running into a never-shown workspace");

        expect(argv).toEqual([]);
    });

    test("NEGATIVE CONTROL: without silent the same open selects the workspace and focuses the window", async () => {
        await openCommandAt({
            command: "echo probe",
            target: { kind: "pane", workspaceId: WORKSPACE, paneId: PANE },
            title: "probe",
        });

        expect(argv.filter(changesView).map((args) => args[0])).toContain("select-workspace");
        expect(argv.filter(changesView).map((args) => args[0])).toContain("focus-window");
    });
});

describe("livePlacementIO() window", () => {
    /** Without `--id-format both`, identify has no `window_id`, and the raise fell back to a ref. */
    test("identifyWindow asks for UUIDs and answers with the window UUID, not its ref", async () => {
        expect(await livePlacementIO().identifyWindow?.(WORKSPACE)).toBe(WINDOW);
        expect(argv).toEqual([["--id-format", "both", "identify", "--workspace", WORKSPACE]]);
    });

    test("focusWindow names the window by the UUID it is given", async () => {
        await livePlacementIO().focusWindow(WINDOW);

        expect(argv).toEqual([["focus-window", "--window", WINDOW]]);
    });
});
