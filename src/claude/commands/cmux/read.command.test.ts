import { afterEach, expect, test } from "bun:test";
import type { ResolveDeps } from "@app/claude/lib/cmux/resolve";
import type { CmuxLiveSnapshot } from "@genesiscz/utils/cmux/lib/live-snapshot";
import type { SessionCmuxRefs } from "@genesiscz/utils/cmux/session-refs";
import { capturePaneArgs, parseReadLines, readSessionText } from "./read";

const SESSION = "8b6e69bf-0efc-4990-ba3e-b77262498421";

function refs(): SessionCmuxRefs {
    return {
        sessionId: SESSION,
        workspaceId: "workspace:11",
        surfaceId: "surface:41",
        workspaceRef: "workspace:11",
        paneRef: "pane:7",
        surfaceRef: "surface:41",
        windowRef: "window:1",
        tmuxPane: null,
        cwd: "/repo",
        at: 1,
    };
}

function emptySnapshot(): CmuxLiveSnapshot {
    return { fetchedAt: "2026-10-08T12:00:00.000Z", available: true, workspaces: [], panes: [] };
}

function deps(overrides: ResolveDeps = {}): ResolveDeps {
    return {
        identify: async () => ({ caller: { pane_ref: "pane:2" } }),
        lookupRefs: () => refs(),
        lookupSession: async () => ({ aliases: [], sessionId: null, cwd: null }),
        fetchSnapshot: async () => emptySnapshot(),
        ...overrides,
    };
}

afterEach(() => {
    process.exitCode = 0;
});

test("capture-pane args carry the workspace, the surface, and the optional window of text", () => {
    expect(capturePaneArgs("workspace:11", "surface:41", {})).toEqual([
        "capture-pane",
        "--workspace",
        "workspace:11",
        "--surface",
        "surface:41",
    ]);
    expect(capturePaneArgs("workspace:11", "surface:41", { lines: 40, scrollback: true })).toEqual([
        "capture-pane",
        "--workspace",
        "workspace:11",
        "--surface",
        "surface:41",
        "--scrollback",
        "--lines",
        "40",
    ]);
    expect(parseReadLines(undefined)).toBeUndefined();
    expect(parseReadLines("40")).toBe(40);
    expect(() => parseReadLines("0")).toThrow("positive integer");
    expect(() => parseReadLines("nope")).toThrow("positive integer");
});

test("read uses the same recorded session surface as send and prints the pane text", async () => {
    const calls: string[][] = [];
    const text = await readSessionText(SESSION, { lines: "40", scrollback: true }, deps(), async (args) => {
        calls.push(args);
        return { code: 0, stdout: "hello from the pane\n", stderr: "" };
    });

    expect(text).toBe("hello from the pane\n");
    expect(calls).toEqual([
        ["capture-pane", "--workspace", "workspace:11", "--surface", "surface:41", "--scrollback", "--lines", "40"],
    ]);
});

test("a session with no pane prints nothing and does not capture", async () => {
    const calls: string[][] = [];
    const text = await readSessionText(SESSION, {}, deps({ lookupRefs: () => null }), async (args) => {
        calls.push(args);
        return { code: 0, stdout: "nope", stderr: "" };
    });

    expect(text).toBeNull();
    expect(process.exitCode).toBe(1);
    expect(calls).toEqual([]);
});
