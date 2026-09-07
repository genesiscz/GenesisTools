import { expect, test } from "bun:test";
import type { AutosaveSession } from "@app/cmux/lib/autosave";
import type { CapturedCommand } from "@app/cmux/lib/capture-journal";
import { buildTerminalSurfaceSnapshot, capturedCommandsByPanelId } from "@app/cmux/lib/snapshot";

const stableId = "11111111-1111-4111-8111-111111111111";
const journal: CapturedCommand = {
    version: 1,
    surfaceId: stableId,
    command: "tools usage --name 'two words'",
    cwd: "/launch cwd",
    phase: "completed",
    atMs: 100,
    exitStatus: 0,
};

test("live capture joins stable native IDs and preserves exact command syntax over foreground processes", () => {
    const autosave: AutosaveSession = {
        path: "/fixture",
        savedAtMs: 200,
        windows: [
            {
                tabManager: {
                    workspaces: [
                        {
                            layout: { type: "pane", pane: { panelIds: ["native-panel"] } },
                            panels: [{ id: "native-panel", stableSurfaceId: stableId, type: "terminal" }],
                        },
                    ],
                },
            },
        ],
    };
    const captured = buildTerminalSurfaceSnapshot({
        entry: { ref: "surface:1", id: "NATIVE-PANEL", type: "terminal", title: "grok", index: 0 },
        captureCwd: true,
        captured: { command: { value: "echo stale", source: "scrollback" } },
        capture: {
            ttyCommands: new Map([["ttys001", "some unrelated child process"]]),
            panelTty: new Map([["native-panel", "ttys001"]]),
            panelCwd: new Map([["native-panel", "/wrong cwd"]]),
            surfaceSessions: new Map(),
            replayCatalog: { sessions: [] },
            surfaceCommands: capturedCommandsByPanelId(autosave, new Map([[stableId, journal]])),
        },
    });
    expect(captured).toMatchObject({
        command: "tools usage --name 'two words'",
        command_source: "shell-journal",
        cwd: "/launch cwd",
    });
});

test("live capture pins a known Claude session without losing the journal's launcher flags", () => {
    const captured = buildTerminalSurfaceSnapshot({
        entry: { ref: "surface:1", id: stableId, type: "terminal", title: "grok", index: 0 },
        captureCwd: true,
        captured: { command: { value: undefined, source: "none" } },
        capture: {
            ttyCommands: new Map(),
            panelTty: new Map(),
            panelCwd: new Map(),
            replayCatalog: { sessions: [] },
            surfaceSessions: new Map([[stableId, { sessionId: "known-session" }]]),
            surfaceCommands: new Map([[stableId, { ...journal, command: "claude --model custom" }]]),
        },
    });
    expect(captured).toMatchObject({
        command: "claude --model custom --resume known-session",
        command_original: "claude --model custom",
        command_source: "shell-journal",
        cwd: "/launch cwd",
    });
});

test("live capture still falls back to the foreground process when no shell journal exists", () => {
    const captured = buildTerminalSurfaceSnapshot({
        entry: { ref: "surface:1", id: stableId, type: "terminal", title: "usage", index: 0 },
        captureCwd: true,
        captured: { command: { value: "echo stale", source: "scrollback" } },
        capture: {
            ttyCommands: new Map([["ttys001", "tail -f /tmp/log"]]),
            panelTty: new Map([[stableId, "ttys001"]]),
            panelCwd: new Map([[stableId, "/cwd"]]),
            replayCatalog: { sessions: [] },
            surfaceSessions: new Map(),
        },
    });
    expect(captured).toMatchObject({ command: "tail -f /tmp/log", command_source: "foreground", cwd: "/cwd" });
});

test("live save uses native saved output when a dormant terminal cannot be read", () => {
    const capture = {
        ttyCommands: new Map<string, string>(),
        panelTty: new Map<string, string>(),
        panelCwd: new Map([[stableId, "/tmp/project"]]),
        surfaceSessions: new Map(),
        replayCatalog: { sessions: [] },
        panelScreens: new Map([[stableId, { text: "➜  project tail -f app.log\nready", rows: 2 }]]),
    };
    const input = {
        entry: { ref: "surface:99", id: stableId, type: "terminal" as const, title: "Logs", index: 0 },
        captureCwd: true,
        captured: { command: { value: undefined, source: "none" as const } },
        capture,
    };
    expect(buildTerminalSurfaceSnapshot(input)).toMatchObject({
        screen: { text: "➜  project tail -f app.log\nready" },
        command: "tail -f app.log",
        command_source: "scrollback",
    });
    const noContent = buildTerminalSurfaceSnapshot({ ...input, captureScreen: false, captureHistory: false });
    expect(noContent).toMatchObject({ type: "terminal", cwd: "/tmp/project" });
    expect(noContent.type === "terminal" && noContent.screen).toBeUndefined();
    expect(noContent.type === "terminal" && noContent.command).toBeUndefined();
});
