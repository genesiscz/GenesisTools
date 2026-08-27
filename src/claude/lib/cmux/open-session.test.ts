import { describe, expect, test } from "bun:test";
import { PLACEMENT_SETTLE_MS, raiseThenSend } from "@app/claude/lib/cmux/open-session";

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
