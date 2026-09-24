import { describe, expect, test } from "bun:test";
import { launchTarget, PLACEMENT_SETTLE_MS, raiseThenSend } from "./open-command";

describe("raiseThenSend", () => {
    /** A new workspace has never been rendered; send before select is a silent no-op. */
    test("selects the workspace, waits, then types, then raises the window", async () => {
        const calls: string[] = [];

        await raiseThenSend(
            {
                workspaceRef: "workspace:12",
                surfaceRef: "surface:44",
                payload: "tools claude run --resume abc\n",
                windowRef: "window:1",
            },
            {
                selectWorkspace: async (ref) => {
                    calls.push(`select ${ref}`);
                },
                send: async (workspace, surface, payload) => {
                    calls.push(`send ${workspace} ${surface} ${payload.trimEnd()}`);
                },
                focusWindow: async (ref) => {
                    calls.push(`focus ${ref}`);
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
            "select workspace:12",
            `sleep ${PLACEMENT_SETTLE_MS}`,
            "send workspace:12 surface:44 tools claude run --resume abc",
            "focus window:1",
            "activate",
        ]);
    });

    test("resolves the window from identify when none is given", async () => {
        const calls: string[] = [];

        await raiseThenSend(
            {
                workspaceRef: "workspace:12",
                surfaceRef: "surface:44",
                payload: "cmd\n",
            },
            {
                selectWorkspace: async () => {
                    calls.push("select");
                },
                send: async () => {
                    calls.push("send");
                },
                focusWindow: async (ref) => {
                    calls.push(`focus ${ref}`);
                },
                identifyWindow: async (workspace) => {
                    calls.push(`identify ${workspace}`);
                    return "window:7";
                },
                sleep: async () => {
                    calls.push("sleep");
                },
            }
        );

        expect(calls).toEqual(["select", "sleep", "send", "identify workspace:12", "focus window:7"]);
    });
});

describe("launchTarget", () => {
    const focused = { window_ref: "window:1", workspace_ref: "workspace:2", pane_ref: "pane:3" };

    test("new is a tab in the focused pane, split a pane in the focused workspace, workspace a new one in the window", () => {
        expect(launchTarget(undefined, focused)).toEqual({
            kind: "pane",
            workspaceRef: "workspace:2",
            paneRef: "pane:3",
        });
        expect(launchTarget("new", focused)).toEqual({ kind: "pane", workspaceRef: "workspace:2", paneRef: "pane:3" });
        expect(launchTarget("split", focused)).toEqual({ kind: "workspace", workspaceRef: "workspace:2" });
        expect(launchTarget("workspace", focused)).toEqual({ kind: "window", windowRef: "window:1" });
    });

    test("no focused workspace is an error, not a launch into the wrong place", () => {
        expect(() => launchTarget("new", {})).toThrow("no focused workspace");
    });
});
