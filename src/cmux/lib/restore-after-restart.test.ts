import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { setCcRunAliases } from "@app/cmux/lib/command-capture";
import type { Profile, Surface, TerminalSurface } from "@app/cmux/lib/types";
import { PROFILE_VERSION } from "@app/cmux/lib/types";
import { filterReplayByAgents, isMissingEnumFlag, parseAgentList, parseRestoreSource } from "./restore-after-restart";
import { agentsOnTtys, idleShellTtys, type LiveTab, planInPlaceRestore } from "./restore-in-place";

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
            // What a live capture sets when the surface journal named the session.
            resume_evidence: "journal",
            ...extra,
        };
    }

    const GROK_STALE = "b4d9d27d-1597-48fd-b6a6-f5ed76feb360";
    const GROK_RIGHT = "01a05cc5-0ecf-7d40-945e-977e45b3f935";
    const TRUST = "Do you trust the contents of this directory?\n  Yes, proceed   y\n  No, quit       n\n";
    const surfaces: Surface[] = [
        tab(1, "alias", `ffff work -- --resume ${CLAUDE_ID}`),
        tab(2, "canonical", `tools claude start work -- --resume ${CLAUDE_ID}`),
        tab(3, "busy", `grok -r ${GROK_RIGHT}`),
        tab(4, "me", `ffff work -- --resume ${CLAUDE_ID}`),
        tab(5, "new session", "ffff work"),
        tab(6, "ssh", "ssh deploy@example.com"),
        { type: "browser", title: "docs", url: "http://127.0.0.1:3000" },
        tab(7, "typed", `ffff work -- --resume ${CLAUDE_ID}`),
        tab(8, "weak", `ffff work -- --resume ${CLAUDE_ID}`, { resume_evidence: "weak" }),
        tab(9, "gone", `ffff work -- --resume ${CLAUDE_ID}`),
        tab(10, "stale grok", `tools claude start work -- --resume ${CLAUDE_ID}`),
        tab(11, "already", `grok -r ${GROK_RIGHT}`),
    ];
    // The live refs are renumbered after a relaunch; only the UUIDs match the capture.
    const tabs = new Map(
        [1, 2, 3, 4, 5, 6, 7, 8, 10, 11].map((n) => [
            uuid(n),
            {
                id: uuid(n).toUpperCase(),
                workspaceId: "AAAAAAAA-0000-4000-8000-000000000070",
                tty: `ttys0${n}`,
                title: null,
                ref: `surface:${100 + n}`,
                workspaceRef: "workspace:70",
                windowRef: "window:9",
            },
        ])
    );
    const state = {
        tabs,
        idleTtys: new Set(["ttys01", "ttys02", "ttys04", "ttys05", "ttys06", "ttys07", "ttys08"]),
        ttyAgents: new Map([
            ["ttys03", { kind: "claude" as const, sessionId: "99999999-9999-4999-8999-999999999999" }],
            ["ttys010", { kind: "grok" as const, sessionId: GROK_STALE }],
            ["ttys011", { kind: "grok" as const, sessionId: GROK_RIGHT }],
        ]),
        screens: new Map([
            [uuid(1), PROMPT],
            [uuid(2), PROMPT],
            [uuid(5), PROMPT],
            [uuid(6), PROMPT],
            [uuid(7), `${PROMPT}half a sente`],
            [uuid(8), PROMPT],
            [uuid(10), TRUST],
            [uuid(11), "grok ready"],
        ]),
        callerId: uuid(4),
    };

    test("pairs by surface UUID and prepares or skips each tab with its reason", () => {
        const steps = planInPlaceRestore(liveProfile(surfaces), state);
        const byTitle = new Map(steps.map((step) => [step.title, step]));

        const planned = (title: string) => [
            byTitle.get(title)?.kind,
            byTitle.get(title)?.skip,
            byTitle.get(title)?.prepare,
        ];

        expect(planned("alias")).toEqual(["agent", undefined, undefined]);
        expect(byTitle.get("alias")?.live?.ref).toBe("surface:101");
        expect(planned("canonical")).toEqual(["agent", undefined, undefined]);
        expect(byTitle.get("busy")?.skip).toBe(
            `a program already runs here (claude 99999999-9999-4999-8999-999999999999); the recorded session for this tab is: grok -r ${GROK_RIGHT}`
        );
        expect(byTitle.get("me")?.skip).toBe("this tab runs the restore");
        expect(byTitle.get("new session")?.skip).toBe(
            "no session id resolved, so the command would open a new session or a picker"
        );
        expect(planned("ssh")).toEqual(["command", undefined, undefined]);
        expect(planned("typed")).toEqual(["agent", undefined, "clear-prompt"]);
        expect(byTitle.get("typed")?.prepareNote).toContain("half a sente");
        expect(byTitle.get("weak")?.skip).toContain("only weak evidence ties this tab to the session");
        expect(byTitle.get("gone")).toMatchObject({ live: undefined, skip: "the tab is no longer in the live layout" });
        expect(planned("stale grok")).toEqual(["agent", undefined, "quit-stale-agent"]);
        expect(byTitle.get("already")?.skip).toBe("already runs the recorded session");
    });

    // Sonnet F7 and F18 (2026-10-14): a path that set no evidence, or a tab whose screen cmux could not read, is
    // never typed into. The old rule skipped only "weak", and an unread screen became a blind Ctrl-U.
    test("a session with no recorded evidence, or a tab with an unreadable screen, is skipped with its reason", () => {
        const noEvidence = planInPlaceRestore(
            liveProfile([{ ...tab(1, "alias", `ffff work -- --resume ${CLAUDE_ID}`), resume_evidence: undefined }]),
            state
        );
        expect(noEvidence[0]?.skip).toContain("no evidence recorded for this session");

        const unread = { ...state, screens: new Map([...state.screens].filter(([key]) => key !== uuid(1))) };
        const blind = planInPlaceRestore(liveProfile([tab(1, "alias", `ffff work -- --resume ${CLAUDE_ID}`)]), unread);
        expect(blind[0]?.prepare).toBeUndefined();
        expect(blind[0]?.skip).toContain("could not read this tab's screen");

        const strange = { ...state, screens: new Map([...state.screens, [uuid(1), "some program output"]]) };
        const unknown = planInPlaceRestore(
            liveProfile([tab(1, "alias", `ffff work -- --resume ${CLAUDE_ID}`)]),
            strange
        );
        expect(unknown[0]?.skip).toContain("not a shell prompt this restore knows");
    });

    test("a stale agent that already opened its session is never quit", () => {
        const opened = { ...state, screens: new Map([...state.screens, [uuid(10), "grok ready ❯"]]) };
        const step = planInPlaceRestore(liveProfile(surfaces), opened).find((s) => s.title === "stale grok");

        expect(step?.prepare).toBeUndefined();
        expect(step?.skip).toContain(`a program already runs here (grok ${GROK_STALE})`);
    });

    // Measured 2026-10-14: a tab opened in the background has `tty: null` in `cmux tree` until it is drawn,
    // which took over 20 s for a fresh split. Without the tty nothing proves the tab is an idle shell.
    test("a tab cmux reports no tty for is skipped, never typed into", () => {
        const alias = tabs.get(uuid(1));

        if (!alias) {
            throw new Error("fixture tab 1 is missing");
        }

        const noTty = { ...state, tabs: new Map<string, LiveTab>([...tabs, [uuid(1), { ...alias, tty: null }]]) };
        const step = planInPlaceRestore(liveProfile(surfaces), noTty).find((s) => s.title === "alias");

        expect(step?.prepare).toBeUndefined();
        expect(step?.skip).toContain("cmux reports no tty for this tab yet");
    });
});

describe("agentsOnTtys", () => {
    test("reads the agent and its session off each tty's command line, path and all", () => {
        const proc = (tty: string, command: string) =>
            ({
                pid: 1,
                ppid: 0,
                pgid: 1,
                uid: 501,
                name: "x",
                command,
                tty,
                startMs: null,
                zombie: false,
                state: "S",
            }) as const;
        const agents = agentsOnTtys(
            [
                proc("ttys003", "/Users/me/.local/bin/grok -r b4d9d27d-1597-48fd-b6a6-f5ed76feb360"),
                proc(
                    "ttys005",
                    "/Users/me/.bun/bin/claude --dangerously-skip-permissions --resume 6bdfb457-cee9-4202-8105-21be8a801757"
                ),
                proc("ttys006", "/bin/zsh -l"),
            ],
            501
        );

        expect(agents.get("ttys003")).toEqual({ kind: "grok", sessionId: "b4d9d27d-1597-48fd-b6a6-f5ed76feb360" });
        expect(agents.get("ttys005")).toEqual({ kind: "claude", sessionId: "6bdfb457-cee9-4202-8105-21be8a801757" });
        expect(agents.has("ttys006")).toBe(false);
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

    test("a tty whose only process of this user is one shell is idle; anything more makes it busy", () => {
        const idle = idleShellTtys(
            [
                proc("ttys001", "login", 0),
                proc("ttys001", "-zsh"),
                // A script under bash waiting for input: by name a second shell, in fact a running program.
                proc("ttys002", "-zsh"),
                proc("ttys002", "bash"),
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
