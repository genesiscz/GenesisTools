import { expect, test } from "bun:test";
import { buildOfflinePanes } from "@app/cmux/lib/offline-snapshot";

test("stable surface command journal restores a usage tab despite stale native agent metadata", () => {
    const panes = buildOfflinePanes(
        {
            layout: { type: "pane", pane: { panelIds: ["new-id"] } },
            panels: [
                {
                    id: "new-id",
                    stableSurfaceId: "11111111-1111-4111-8111-111111111111",
                    type: "terminal",
                    title: "usage",
                    directory: "/new cwd",
                    terminal: { agent: { kind: "codex", sessionId: "stale" } },
                },
            ],
        },
        { x: 0, y: 0, width: 800, height: 600 },
        {
            ttyCommands: new Map(),
            surfaceSessions: new Map(),
            surfaceCommands: new Map([
                [
                    "11111111-1111-4111-8111-111111111111",
                    {
                        version: 1,
                        surfaceId: "11111111-1111-4111-8111-111111111111",
                        atMs: 100,
                        command: "tools usage --name 'two words'",
                        cwd: "/launch cwd",
                        phase: "completed",
                        exitStatus: 0,
                    },
                ],
            ]),
        }
    );
    expect(panes[0].surfaces[0]).toMatchObject({ command: "tools usage --name 'two words'", cwd: "/launch cwd" });
});

test("a shell capture is authoritative over another agent's stale native binding and title", () => {
    const panes = buildOfflinePanes(
        {
            layout: { type: "pane", pane: { panelIds: ["11111111-1111-4111-8111-111111111111"] } },
            panels: [
                {
                    id: "11111111-1111-4111-8111-111111111111",
                    type: "terminal",
                    title: "grok",
                    terminal: {
                        agent: { kind: "grok", sessionId: "wrong-agent-session", workingDirectory: "/wrong cwd" },
                    },
                },
            ],
        },
        { x: 0, y: 0, width: 800, height: 600 },
        {
            ttyCommands: new Map(),
            surfaceSessions: new Map(),
            surfaceCommands: new Map([
                [
                    "11111111-1111-4111-8111-111111111111",
                    {
                        version: 1,
                        surfaceId: "11111111-1111-4111-8111-111111111111",
                        atMs: 100,
                        command: "codex --model custom",
                        cwd: "/launch cwd",
                        phase: "running",
                    },
                ],
            ]),
        }
    );
    expect(panes[0].surfaces[0]).toMatchObject({ command: "codex --model custom", cwd: "/launch cwd" });
});
