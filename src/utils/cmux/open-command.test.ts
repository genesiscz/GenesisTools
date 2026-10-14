import { describe, expect, test } from "bun:test";
import { launchTarget, PLACEMENT_SETTLE_MS, raiseThenSend } from "./open-command";

const WINDOW = "0B000000-0000-4000-8000-000000000001";
const WORKSPACE = "11111111-1111-4111-8111-111111111112";
const PANE = "22222222-2222-4222-8222-222222222203";
const SURFACE = "33333333-3333-4333-8333-333333333344";

describe("raiseThenSend", () => {
    /** A new workspace has never been rendered; send before select is a silent no-op. */
    test("selects the workspace, waits, then types, then raises the window", async () => {
        const calls: string[] = [];

        await raiseThenSend(
            {
                workspaceId: WORKSPACE,
                surfaceId: SURFACE,
                payload: "tools claude run --resume abc\n",
                windowId: WINDOW,
            },
            {
                selectWorkspace: async (id) => {
                    calls.push(`select ${id}`);
                },
                send: async (workspace, surface, payload) => {
                    calls.push(`send ${workspace} ${surface} ${payload.trimEnd()}`);
                },
                focusWindow: async (id) => {
                    calls.push(`focus ${id}`);
                },
                activateApp: async () => {
                    calls.push("activate");
                },
                sleep: async (ms) => {
                    calls.push(`sleep ${ms}`);
                },
            }
        );

        expect(calls).toEqual([
            `select ${WORKSPACE}`,
            `sleep ${PLACEMENT_SETTLE_MS}`,
            `send ${WORKSPACE} ${SURFACE} tools claude run --resume abc`,
            `focus ${WINDOW}`,
            "activate",
        ]);
    });

    test("resolves the window from identify when none is given", async () => {
        const calls: string[] = [];

        await raiseThenSend(
            {
                workspaceId: WORKSPACE,
                surfaceId: SURFACE,
                payload: "cmd\n",
            },
            {
                selectWorkspace: async () => {
                    calls.push("select");
                },
                send: async () => {
                    calls.push("send");
                },
                focusWindow: async (id) => {
                    calls.push(`focus ${id}`);
                },
                identifyWindow: async (workspace) => {
                    calls.push(`identify ${workspace}`);
                    return WINDOW;
                },
                sleep: async () => {
                    calls.push("sleep");
                },
            }
        );

        expect(calls).toEqual(["select", "sleep", "send", `identify ${WORKSPACE}`, `focus ${WINDOW}`]);
    });
});

describe("launchTarget", () => {
    const focused = {
        window_id: WINDOW,
        workspace_id: WORKSPACE,
        pane_id: PANE,
        window_ref: "window:1",
        workspace_ref: "workspace:2",
        pane_ref: "pane:3",
    };

    test("new is a tab in the focused pane, split a pane in the focused workspace, workspace a new one in the window", () => {
        expect(launchTarget(undefined, focused)).toEqual({ kind: "pane", workspaceId: WORKSPACE, paneId: PANE });
        expect(launchTarget("new", focused)).toEqual({ kind: "pane", workspaceId: WORKSPACE, paneId: PANE });
        expect(launchTarget("split", focused)).toEqual({ kind: "workspace", workspaceId: WORKSPACE });
        expect(launchTarget("workspace", focused)).toEqual({ kind: "window", windowId: WINDOW });
    });

    test("no focused workspace is an error, not a launch into the wrong place", () => {
        expect(() => launchTarget("new", {})).toThrow("no focused workspace");
    });

    /** Refs alone (identify without `--id-format both`) are not enough: a launch never targets a ref. */
    test("an identify answer with refs only is refused, not launched by ref", () => {
        const refsOnly = { window_ref: "window:1", workspace_ref: "workspace:2", pane_ref: "pane:3" };

        expect(() => launchTarget("new", refsOnly)).toThrow("no focused workspace");
        expect(() => launchTarget("workspace", refsOnly)).toThrow("no focused window");
    });
});
