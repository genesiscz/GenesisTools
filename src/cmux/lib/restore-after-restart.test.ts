import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { setCcRunAliases } from "@app/cmux/lib/command-capture";
import type { Profile, Surface, TerminalSurface } from "@app/cmux/lib/types";
import { PROFILE_VERSION } from "@app/cmux/lib/types";
import { filterReplayByAgents, isMissingEnumFlag, parseAgentList, parseRestoreSource } from "./restore-after-restart";
import { idleShellTtys, planInPlaceRestore } from "./restore-in-place";

describe("parseRestoreSource", () => {
    test("accepts previous, live, profile", () => {
        expect(parseRestoreSource("previous")).toBe("previous");
        expect(parseRestoreSource("live")).toBe("live");
        expect(parseRestoreSource("profile")).toBe("profile");
        expect(parseRestoreSource("nope")).toBeUndefined();
    });
});

describe("parseAgentList", () => {
    test("defaults to all three agents", () => {
        expect(parseAgentList(undefined)).toEqual(["claude", "grok", "codex"]);
    });

    test("parses a subset", () => {
        expect(parseAgentList("grok,codex")).toEqual(["grok", "codex"]);
    });

    test("rejects an unknown name instead of dropping it", () => {
        expect(() => parseAgentList("nope")).toThrow(/got "nope"/);
        expect(() => parseAgentList("grok,foo")).toThrow(/got "grok,foo"/);
    });
});

describe("isMissingEnumFlag", () => {
    test("treats a bare commander true as missing", () => {
        expect(isMissingEnumFlag(true)).toBe(true);
        expect(isMissingEnumFlag("")).toBe(true);
        expect(isMissingEnumFlag("grok")).toBe(false);
        expect(isMissingEnumFlag(undefined)).toBe(false);
    });
});

describe("filterReplayByAgents", () => {
    const profile: Profile = {
        version: PROFILE_VERSION,
        name: "restart",
        scope: "all",
        captured_at: "2026-09-03T15:42:00.000Z",
        cmux_version: "test",
        windows: [
            {
                ref: "window:1",
                title: "Window 1",
                container_frame: { width: 100, height: 100 },
                workspaces: [
                    {
                        ref: "workspace:1",
                        title: "ws",
                        selected: true,
                        panes: [
                            {
                                ref: "pane:1",
                                index: 0,
                                columns: 80,
                                rows: 24,
                                pixel_frame: { x: 0, y: 0, width: 80, height: 24 },
                                selected_surface_index: 0,
                                surfaces: [
                                    {
                                        type: "terminal",
                                        title: "PRs merged - grok",
                                        command: "grok -r 01a05cc5-0ecf-7d40-945e-977e45b3f935",
                                    },
                                    {
                                        type: "terminal",
                                        title: "✳ Continue",
                                        command: "claude --resume 6bdfb457-cee9-4202-8105-21be8a801757",
                                    },
                                ],
                            },
                        ],
                    },
                ],
            },
        ],
    };

    test("drops grok resume commands when grok is not selected", () => {
        const filtered = filterReplayByAgents(profile, ["claude"]);
        const surfaces = filtered.windows[0]?.workspaces[0]?.panes[0]?.surfaces ?? [];
        expect(surfaces[0] && surfaces[0].type === "terminal" ? surfaces[0].command : "missing").toBeUndefined();
        expect(surfaces[1] && surfaces[1].type === "terminal" ? surfaces[1].command : "missing").toContain("claude");
    });

    test("the actual executable wins over a stale grok title", () => {
        const input = structuredClone(profile);
        input.windows[0].workspaces[0].panes[0].surfaces = [
            {
                type: "terminal",
                title: "Old task - grok",
                command: "/opt/homebrew/bin/codex resume test-session",
                command_source: "foreground",
            },
        ];
        const filtered = filterReplayByAgents(input, ["grok"]);
        expect(filtered.windows[0].workspaces[0].panes[0].surfaces[0]).toMatchObject({ command: undefined });
        expect(filterReplayByAgents(input, ["codex"]).windows[0].workspaces[0].panes[0].surfaces[0]).toMatchObject({
            command: "/opt/homebrew/bin/codex resume test-session",
        });
    });

    test("never replays the restore command itself but retains other shell commands", () => {
        const input = structuredClone(profile);
        input.windows[0].workspaces[0].panes[0].surfaces = [
            {
                type: "terminal",
                title: "Restore",
                command: "tools cmux restore-after-restart --enter -y",
                command_source: "foreground",
            },
            { type: "terminal", title: "Logs", command: "tail -f app.log", command_source: "foreground" },
        ];
        const surfaces = filterReplayByAgents(input, ["claude", "grok", "codex"]).windows[0].workspaces[0].panes[0]
            .surfaces;
        expect(surfaces[0]).toMatchObject({ command: undefined });
        expect(surfaces[1]).toMatchObject({ command: "tail -f app.log" });
    });

    test("agent filtering also recognizes relative executable paths", () => {
        for (const command of ["./codex resume fixture", "~/bin/codex resume fixture", "bin/codex resume fixture"]) {
            const input = structuredClone(profile);
            input.windows[0].workspaces[0].panes[0].surfaces = [
                { type: "terminal", title: "old - grok", command, command_source: "shell-journal" },
            ];
            expect(filterReplayByAgents(input, ["grok"]).windows[0].workspaces[0].panes[0].surfaces[0]).toMatchObject({
                command: undefined,
            });
            expect(filterReplayByAgents(input, ["codex"]).windows[0].workspaces[0].panes[0].surfaces[0]).toMatchObject({
                command,
            });
        }
    });
});

describe("planInPlaceRestore", () => {
    // The launcher name is the user's own: any wrapper in ~/.aliases that execs `tools cc run` counts, so the
    // fixture uses a made-up one. A launcher the code does not know resolves through the surface journal
    // instead (command-capture.test.ts, journalReplayCommand) and arrives here as `tools claude start`.
    beforeAll(() => {
        setCcRunAliases(["ffff"]);
    });

    afterAll(() => {
        setCcRunAliases(undefined);
    });

    const CLAUDE_ID = "6bdfb457-cee9-4202-8105-21be8a801757";
    const PROMPT = "Last login: Wed Oct 14 20:09:23\n➜  App git:(main) ✗ ";
    const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

    function liveProfile(surfaces: Surface[]): Profile {
        return {
            version: PROFILE_VERSION,
            name: "restart-live",
            scope: "all",
            captured_at: "2026-10-14T18:11:00.000Z",
            cmux_version: "test",
            windows: [
                {
                    ref: "window:1",
                    title: "Window 1",
                    container_frame: { width: 100, height: 100 },
                    workspaces: [
                        {
                            ref: "workspace:7",
                            title: "triage",
                            selected: true,
                            panes: [
                                {
                                    ref: "pane:3",
                                    index: 0,
                                    columns: 80,
                                    rows: 24,
                                    pixel_frame: { x: 0, y: 0, width: 80, height: 24 },
                                    selected_surface_index: 0,
                                    surfaces,
                                },
                            ],
                        },
                    ],
                },
            ],
        };
    }

    function tab(n: number, title: string, command?: string, extra: Partial<TerminalSurface> = {}): TerminalSurface {
        return {
            type: "terminal",
            title,
            surface_id: uuid(n),
            cwd: "/Users/me/Projects/App",
            command,
            command_source: "shell-journal",
            ...extra,
        };
    }

    const surfaces: Surface[] = [
        tab(1, "alias", `ffff work -- --resume ${CLAUDE_ID}`),
        tab(2, "canonical", `tools claude start work -- --resume ${CLAUDE_ID}`),
        tab(3, "busy", `grok -r 01a05cc5-0ecf-7d40-945e-977e45b3f935`),
        tab(4, "me", `ffff work -- --resume ${CLAUDE_ID}`),
        tab(5, "new session", "ffff work"),
        tab(6, "ssh", "ssh deploy@example.com"),
        { type: "browser", title: "docs", url: "http://127.0.0.1:3000" },
        tab(7, "typed", `ffff work -- --resume ${CLAUDE_ID}`),
        tab(8, "weak", `ffff work -- --resume ${CLAUDE_ID}`, { resume_evidence: "weak" }),
        tab(9, "gone", `ffff work -- --resume ${CLAUDE_ID}`),
    ];
    // Live refs renumber after a relaunch; the UUIDs stay, so the pairing must use them.
    const tabs = new Map(
        [1, 2, 3, 4, 5, 6, 7, 8].map((n) => [
            uuid(n),
            {
                ref: `surface:${100 + n}`,
                id: uuid(n).toUpperCase(),
                workspace: "workspace:70",
                workspaceId: null,
                window: "window:9",
                tty: `ttys0${n}`,
                title: null,
            },
        ])
    );
    const state = {
        tabs,
        idleTtys: new Set(["ttys01", "ttys02", "ttys04", "ttys05", "ttys06", "ttys07", "ttys08"]),
        screens: new Map([
            ["surface:101", PROMPT],
            ["surface:102", PROMPT],
            ["surface:105", PROMPT],
            ["surface:106", PROMPT],
            ["surface:107", `${PROMPT}half a sente`],
            ["surface:108", PROMPT],
        ]),
        callerSurfaceRef: "surface:104",
    };

    test("pairs by surface UUID and types only into an idle shell with an empty prompt", () => {
        const steps = planInPlaceRestore(liveProfile(surfaces), state);
        const byTitle = new Map(steps.map((step) => [step.title, step]));

        expect(steps.map((step) => step.title)).toEqual([
            "alias",
            "canonical",
            "busy",
            "me",
            "new session",
            "ssh",
            "typed",
            "weak",
            "gone",
        ]);
        expect(byTitle.get("alias")).toMatchObject({
            surfaceRef: "surface:101",
            workspaceRef: "workspace:70",
            kind: "agent",
            skip: undefined,
        });
        expect(byTitle.get("canonical")).toMatchObject({ kind: "agent", skip: undefined });
        expect(byTitle.get("busy")?.skip).toBe(
            "a program already runs here; the recorded session for this tab is: grok -r 01a05cc5-0ecf-7d40-945e-977e45b3f935"
        );
        expect(byTitle.get("me")?.skip).toBe("this tab runs the restore");
        expect(byTitle.get("new session")?.skip).toBe(
            "no session id resolved, so the command would open a new session or a picker"
        );
        expect(byTitle.get("ssh")).toMatchObject({ kind: "command", skip: undefined });
        expect(byTitle.get("typed")?.skip).toBe("the prompt is not empty (text is typed at it), so nothing is typed");
        expect(byTitle.get("weak")?.skip).toContain("only weak evidence ties this tab to the session");
        expect(byTitle.get("gone")).toMatchObject({
            surfaceRef: undefined,
            skip: "the tab is no longer in the live layout",
        });
    });
});

describe("idleShellTtys", () => {
    const proc = (tty: string, name: string, uid = 501) =>
        ({
            pid: 1,
            ppid: 0,
            pgid: 1,
            uid,
            name,
            command: null,
            tty,
            startMs: null,
            zombie: false,
            state: "S",
        }) as const;

    test("a tty with only this user's shells is idle; any other program makes it busy", () => {
        const idle = idleShellTtys(
            [
                proc("ttys001", "login", 0),
                proc("ttys001", "-zsh"),
                proc("ttys001", "zsh"),
                proc("ttys003", "zsh"),
                proc("ttys003", "grok-1.0.52-maco"),
                proc("ttys005", "zsh"),
                proc("ttys005", "ssh"),
            ],
            501
        );

        expect([...idle]).toEqual(["ttys001"]);
    });
});
