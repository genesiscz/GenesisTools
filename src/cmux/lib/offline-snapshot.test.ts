import { describe, expect, test } from "bun:test";
import type { AutosaveWorkspace } from "@app/cmux/lib/autosave";
import { flattenLayout } from "@app/cmux/lib/autosave";
import { buildOfflinePanes, buildOfflineProfile } from "@app/cmux/lib/offline-snapshot";

const FRAME = { x: 0, y: 0, width: 1000, height: 800 };

function workspaceFixture(): AutosaveWorkspace {
    return {
        layout: {
            type: "split",
            split: {
                orientation: "horizontal",
                dividerPosition: 0.5,
                first: { type: "pane", pane: { panelIds: ["a", "b", "c"], selectedPanelId: "b" } },
                second: {
                    type: "split",
                    split: {
                        orientation: "vertical",
                        dividerPosition: 0.25,
                        first: { type: "pane", pane: { panelIds: ["d"] } },
                        second: { type: "pane", pane: { panelIds: ["e"], selectedPanelId: "e" } },
                    },
                },
            },
        },
        panels: [
            { id: "a", type: "terminal", title: "one", directory: "/tmp/one", ttyName: "ttys001" },
            { id: "b", type: "terminal", title: "two", directory: "/tmp/two", ttyName: "ttys002" },
            { id: "c", type: "browser", title: "docs" },
            { id: "d", type: "terminal", title: "three", directory: "/tmp/three", ttyName: "ttys003" },
            { id: "e", type: "terminal", title: "four", directory: "/tmp/four" },
        ],
    };
}

describe("flattenLayout", () => {
    test("splits recursively into frames that tile the container", () => {
        const ws = workspaceFixture();
        const leaves = flattenLayout(ws.layout, FRAME);
        expect(leaves.map((l) => l.panelIds)).toEqual([["a", "b", "c"], ["d"], ["e"]]);
        expect(leaves[0].frame).toEqual({ x: 0, y: 0, width: 500, height: 800 });
        expect(leaves[1].frame).toEqual({ x: 500, y: 0, width: 500, height: 200 });
        expect(leaves[2].frame).toEqual({ x: 500, y: 200, width: 500, height: 600 });
        const area = leaves.reduce((sum, l) => sum + l.frame.width * l.frame.height, 0);
        expect(area).toBe(FRAME.width * FRAME.height);
    });
});

describe("buildOfflinePanes", () => {
    test("uses stable surface journal IDs and terminal cwd even when the title is not a path", () => {
        const ws = workspaceFixture();
        ws.panels[0] = {
            id: "a",
            stableSurfaceId: "stable-a",
            type: "terminal",
            title: "✳ session",
            terminal: { workingDirectory: "/tmp/project" },
        };
        const panes = buildOfflinePanes(ws, FRAME, {
            ttyCommands: new Map(),
            surfaceSessions: new Map([
                ["stable-a", { sessionId: "11111111-aaaa-bbbb-cccc-222222222222", account: "work" }],
            ]),
        });
        expect(panes[0].surfaces[0]).toMatchObject({
            cwd: "/tmp/project",
            command: expect.stringContaining("11111111-aaaa-bbbb-cccc-222222222222"),
        });
    });

    test("restores native session metadata despite an uninformative title", () => {
        const ws = workspaceFixture();
        ws.panels[0] = {
            id: "a",
            type: "terminal",
            title: "project",
            directory: "/tmp/project",
            terminal: {
                agent: {
                    kind: "codex",
                    sessionId: "11111111-aaaa-bbbb-cccc-222222222222",
                    launchCommand: { arguments: ["/opt/bin/codex", "--sandbox", "workspace-write"] },
                },
            },
        };
        const panes = buildOfflinePanes(ws, FRAME, { ttyCommands: new Map(), surfaceSessions: new Map() });
        const surface = panes[0].surfaces[0];
        expect(surface.type === "terminal" && surface.command).toContain("resume 11111111-aaaa-bbbb-cccc-222222222222");
        expect(surface.type === "terminal" && surface.command).toContain("--sandbox workspace-write");
    });

    // Regression test: cmux restart verification, 2026-09-07 — agent cwd differs from the shell cwd.
    test.each([
        { agentCwd: "/tmp/agent-project", bindingCwd: "/tmp/binding-project", expected: "/tmp/agent-project" },
        { agentCwd: undefined, bindingCwd: "/tmp/binding-project", expected: "/tmp/binding-project" },
    ])("resumes native agents in their recorded directory: $expected", ({ agentCwd, bindingCwd, expected }) => {
        const ws = workspaceFixture();
        ws.panels[0].terminal = {
            agent: {
                kind: "codex",
                sessionId: "11111111-aaaa-bbbb-cccc-222222222222",
                workingDirectory: agentCwd,
            },
            resumeBinding: {
                kind: "codex",
                checkpointId: "11111111-aaaa-bbbb-cccc-222222222222",
                cwd: bindingCwd,
            },
        };
        const panes = buildOfflinePanes(ws, FRAME, { ttyCommands: new Map(), surfaceSessions: new Map() });
        expect(panes[0].surfaces[0]).toMatchObject({ cwd: expected });
    });

    test("restores native resume bindings when the agent record is absent", () => {
        const ws = workspaceFixture();
        ws.panels[0] = {
            id: "a",
            type: "terminal",
            title: "project",
            directory: "/tmp/project",
            terminal: {
                resumeBinding: {
                    kind: "codex",
                    checkpointId: "11111111-aaaa-bbbb-cccc-222222222222",
                    cwd: "/tmp/project",
                },
            },
        };
        expect(
            buildOfflinePanes(ws, FRAME, { ttyCommands: new Map(), surfaceSessions: new Map() })[0].surfaces[0]
        ).toMatchObject({ command: "codex resume 11111111-aaaa-bbbb-cccc-222222222222" });
    });
    test("groups tabs per pane, keeps selection, joins commands via tty and enriches claude launchers", () => {
        const ws = workspaceFixture();
        const panes = buildOfflinePanes(ws, FRAME, {
            ttyCommands: new Map([
                ["ttys001", "tools cc run"],
                ["ttys002", "vim notes.md"],
                ["ttys003", "tools cc run work --resume old-name"],
            ]),
            surfaceSessions: new Map([
                ["a", { sessionId: "11111111-aaaa-bbbb-cccc-222222222222", account: "work" }],
                ["d", { sessionId: "33333333-aaaa-bbbb-cccc-444444444444", account: "work" }],
            ]),
        });

        expect(panes).toHaveLength(3);
        expect(panes[0].surfaces.map((s) => s.title)).toEqual(["one", "two", "docs"]);
        expect(panes[0].selected_surface_index).toBe(1);
        expect(panes[0].surfaces[2].type).toBe("browser");

        const first = panes[0].surfaces[0];
        expect(first.type).toBe("terminal");
        if (first.type === "terminal") {
            expect(first.command).toBe("tools cc run work -- --resume 11111111-aaaa-bbbb-cccc-222222222222");
            expect(first.command_original).toBe("tools cc run");
            expect(first.drift?.some((d) => d.includes("account"))).toBe(true);
            expect(first.command_source).toBe("offline");
        }

        const second = panes[0].surfaces[1];
        if (second.type === "terminal") {
            expect(second.command).toBe("vim notes.md");
            expect(second.command_original).toBeUndefined();
            expect(second.drift).toBeUndefined();
        }

        const third = panes[1].surfaces[0];
        if (third.type === "terminal") {
            expect(third.command).toBe("tools cc run work -- --resume 33333333-aaaa-bbbb-cccc-444444444444");
            expect(third.drift?.some((d) => d.includes("replaced"))).toBe(true);
        }

        const fourth = panes[2].surfaces[0];
        if (fourth.type === "terminal") {
            expect(fourth.command).toBeUndefined();
            expect(fourth.cwd).toBe("/tmp/four");
        }
    });

    test("infers grok -r from the tab title when the process table is empty", () => {
        const ws = workspaceFixture();
        ws.panels[4] = {
            id: "e",
            type: "terminal",
            title: "PRs merged into release/2026-09-03 - grok",
            directory: "/tmp/four",
        };
        const panes = buildOfflinePanes(ws, FRAME, {
            ttyCommands: new Map(),
            surfaceSessions: new Map(),
            grokSessions: [
                {
                    kind: "grok",
                    sessionId: "01a05cc5-0ecf-7d40-945e-977e45b3f935",
                    cwd: "/tmp/four",
                    title: "PRs merged into release/2026-09-03",
                },
            ],
        });

        const surface = panes[2].surfaces[0];
        expect(surface.type).toBe("terminal");
        if (surface.type === "terminal") {
            expect(surface.command).toBe("grok -r 01a05cc5-0ecf-7d40-945e-977e45b3f935");
            expect(surface.command_source).toBe("offline");
        }
    });
});

test("offline recovery retains native terminal scrollback and a browser URL", () => {
    const panes = buildOfflinePanes(
        {
            layout: { type: "pane", pane: { panelIds: ["shell", "web"], selectedPanelId: "shell" } },
            panels: [
                {
                    id: "shell",
                    type: "terminal",
                    title: "Logs",
                    directory: "/tmp/project",
                    terminal: { scrollback: "➜  project tail -f app.log\nservice ready\n" },
                },
                { id: "web", type: "browser", title: "Reference", browser: { urlString: "https://example.test/docs" } },
            ],
        },
        FRAME,
        { ttyCommands: new Map(), surfaceSessions: new Map() }
    );
    expect(panes[0].surfaces[0]).toMatchObject({
        screen: { text: "➜  project tail -f app.log\nservice ready", rows: 2 },
        command: "tail -f app.log",
    });
    expect(panes[0].surfaces[1]).toMatchObject({ type: "browser", url: "https://example.test/docs" });
});

test("offline recovery finds cached viewport by persisted identity after a panel move", () => {
    const panes = buildOfflinePanes(
        {
            layout: { type: "pane", pane: { panelIds: ["new-panel"] } },
            panels: [
                {
                    id: "new-panel",
                    stableSurfaceId: "22222222-2222-4222-8222-222222222222",
                    type: "terminal",
                    title: "Monitor",
                    directory: "/tmp/project",
                    terminal: { scrollback: "\u001b[0m  \n" },
                },
            ],
        },
        FRAME,
        {
            ttyCommands: new Map(),
            surfaceSessions: new Map(),
            surfaceScreens: new Map([
                [
                    "22222222-2222-4222-8222-222222222222",
                    { surfaceId: "11111111-1111-4111-8111-111111111111", text: "CPU 2%\nMemory 40 MiB", atMs: 10 },
                ],
            ]),
        }
    );
    expect(panes[0].surfaces[0]).toMatchObject({ screen: { text: "CPU 2%\nMemory 40 MiB", rows: 2 } });
});

test("offline screen opt-out omits both cached and native terminal output", () => {
    const workspace = workspaceFixture();
    workspace.panels[0].terminal = { scrollback: "native fixture text" };
    const session = { path: "/fixture", savedAtMs: 1, windows: [{ tabManager: { workspaces: [workspace] } }] };
    const deps = {
        ttyCommands: new Map<string, string>(),
        surfaceSessions: new Map(),
        surfaceScreens: new Map([
            ["b", { surfaceId: "11111111-1111-4111-8111-111111111111", text: "cached fixture text", atMs: 1 }],
        ]),
    };
    const enabled = buildOfflineProfile(session, deps, { name: "fixture", captureScreen: true });
    expect(enabled.windows[0].workspaces[0].panes[0].surfaces[0]).toMatchObject({
        screen: { text: "native fixture text" },
    });
    const disabled = buildOfflineProfile(session, deps, { name: "fixture", captureScreen: false });
    for (const pane of disabled.windows[0].workspaces[0].panes) {
        for (const surface of pane.surfaces) {
            if (surface.type === "terminal") {
                expect(surface.screen).toBeUndefined();
            }
        }
    }
});
