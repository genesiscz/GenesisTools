import { describe, expect, spyOn, test } from "bun:test";
import {
    aliasesForSession,
    describeMatch,
    findFocusTargets,
    isUnambiguous,
    paneSessionIds,
    resumedSessionIdsIn,
    sessionIdsIn,
} from "@app/claude/lib/cmux/focus";
import {
    findSessionTargets,
    identifiesExactSession,
    type ResolveDeps,
    tmuxHostTargets,
    tmuxMissHint,
} from "@app/claude/lib/cmux/resolve";
import type { CmuxLivePane, CmuxLiveSnapshot, CmuxLiveSurface } from "@genesiscz/utils/cmux/lib/live-snapshot";
import {
    findAllTmuxHosts,
    findTmuxHosts,
    type HostProcess,
    sessionProcessPids,
    type TmuxHost,
    type TmuxHostDeps,
    tmuxAttachCommand,
    tmuxCmuxLocations,
} from "@genesiscz/utils/cmux/tmux-host";
import type { TmuxClientInfo, TmuxPaneInfo, TmuxSocket } from "@genesiscz/utils/tmux/sessions";

const SESSION_A = "8b6e69bf-0efc-4990-ba3e-b77262498421";
const SESSION_B = "f013e93c-a367-46e6-add2-4c026b9cf667";

/** The real shape of a restored pane's screen, copied from a live `cmux read-screen`. */
function resumeScreen(sessionId: string, cwd = "/Users/Martin/projects/GenesisTools"): string {
    return `Last login: Wed Aug 19 12:48:46 on ttys025\ncd -- '${cwd}' && tools claude start -- --resume '${sessionId}'`;
}

/** A restored tab title, as `paneTitle()` writes it: the readable name, then the short id. */
function restoredTitle(sessionId: string, name = "burn the auth callback"): string {
    return `${name} · ${sessionId.slice(0, 8)}`;
}

/** What a restored pane looks like once its Claude TUI has scrolled the resume command away. */
function busyTuiScreen(): string {
    return "╭─ Claude Code ─╮\n│ > continue    │\n╰───────────────╯";
}

function pane(overrides: Partial<CmuxLivePane> & Pick<CmuxLivePane, "id" | "workspaceId">): CmuxLivePane {
    return {
        title: "zsh",
        active: false,
        surfaceCount: 1,
        surfaces: [],
        ...overrides,
    };
}

function surface(overrides: Partial<CmuxLiveSurface> & Pick<CmuxLiveSurface, "id">): CmuxLiveSurface {
    return {
        title: "zsh",
        type: "terminal",
        index: 0,
        selected: false,
        active: false,
        ...overrides,
    };
}

function snapshot(
    panes: CmuxLivePane[],
    workspaces = [{ id: "workspace:11", name: "GenesisTools" }]
): CmuxLiveSnapshot {
    return { fetchedAt: "2026-08-19T13:00:00.000Z", available: true, workspaces, panes };
}

describe("sessionIdsIn", () => {
    test("pulls the id out of a resume command, quotes and all", () => {
        expect(sessionIdsIn(resumeScreen(SESSION_A))).toEqual([SESSION_A]);
    });

    test("dedupes and lowercases", () => {
        const text = `${SESSION_A.toUpperCase()} ${SESSION_A}`;
        expect(sessionIdsIn(text)).toEqual([SESSION_A]);
    });

    test("finds nothing in text with no id", () => {
        expect(sessionIdsIn("just a prompt")).toEqual([]);
    });
});

describe("paneSessionIds", () => {
    test("the session the pane is RESUMING comes first, whatever the screen order", () => {
        // Callers render sessionIds[0] as "the session in this pane". A pane that printed
        // another id above its own resume command would otherwise report that other one in
        // the status line, the picker hint and the table.
        const text = `I looked up ${SESSION_B} for you\n${resumeScreen(SESSION_A)}`;

        expect(sessionIdsIn(text)).toEqual([SESSION_B, SESSION_A]);
        expect(paneSessionIds(text)).toEqual([SESSION_A, SESSION_B]);
    });

    test("keeps screen order when nothing is being resumed", () => {
        expect(paneSessionIds(`${SESSION_B} then ${SESSION_A}`)).toEqual([SESSION_B, SESSION_A]);
    });

    test("never repeats an id that is both resumed and mentioned", () => {
        expect(paneSessionIds(`${SESSION_A}\n${resumeScreen(SESSION_A)}`)).toEqual([SESSION_A]);
    });
});

describe("findFocusTargets", () => {
    test("a full session id matches the pane resuming it", () => {
        const targets = findFocusTargets(
            snapshot([
                pane({ id: "pane:33", workspaceId: "workspace:11", preview: resumeScreen(SESSION_A) }),
                pane({ id: "pane:34", workspaceId: "workspace:11", preview: resumeScreen(SESSION_B) }),
            ]),
            SESSION_A
        );

        expect(targets).toHaveLength(1);
        expect(targets[0].paneId).toBe("pane:33");
        expect(targets[0].matchedOn).toBe("resume-command");
        expect(targets[0].sessionIds).toEqual([SESSION_A]);
    });

    test("copies the window UUID from the live pane so focus can skip identify --workspace", () => {
        const targets = findFocusTargets(
            snapshot([
                pane({
                    id: "pane:33",
                    workspaceId: "workspace:11",
                    windowId: "0B49D0CA-0000-4000-8000-000000000004",
                    preview: resumeScreen(SESSION_A),
                }),
            ]),
            SESSION_A
        );

        expect(targets[0].windowId).toBe("0B49D0CA-0000-4000-8000-000000000004");
    });

    test("the 8-character short form matches as a prefix", () => {
        const targets = findFocusTargets(
            snapshot([pane({ id: "pane:33", workspaceId: "workspace:11", preview: resumeScreen(SESSION_A) })]),
            SESSION_A.slice(0, 8)
        );

        expect(targets[0].matchedOn).toBe("resume-prefix");
    });

    test("a prefix shorter than 8 characters does NOT match an id", () => {
        const targets = findFocusTargets(
            snapshot([pane({ id: "pane:33", workspaceId: "workspace:11", preview: resumeScreen(SESSION_A) })]),
            "8b6"
        );

        // It may still match as screen text, but never as an id — that is the guard
        // against a short hex fragment focusing an unrelated pane.
        for (const target of targets) {
            expect(target.matchedOn).not.toBe("resume-command");
            expect(target.matchedOn).not.toBe("resume-prefix");
            expect(target.matchedOn).not.toBe("title-id");
            expect(target.matchedOn).not.toBe("session-id");
            expect(target.matchedOn).not.toBe("id-prefix");
        }
    });

    test("an id beats a title that also matches", () => {
        const targets = findFocusTargets(
            snapshot([
                pane({ id: "pane:34", workspaceId: "workspace:11", title: `notes about ${SESSION_A}` }),
                pane({ id: "pane:33", workspaceId: "workspace:11", preview: resumeScreen(SESSION_A) }),
            ]),
            SESSION_A
        );

        expect(targets[0].paneId).toBe("pane:33");
        expect(targets[0].matchedOn).toBe("resume-command");
    });

    test("the pane RESUMING a session beats a pane that only printed its id", () => {
        // Found live: an agent pane that had been discussing session ids matched the same
        // query as the pane actually running the session, so every focus asked which one.
        const targets = findFocusTargets(
            snapshot(
                [
                    pane({
                        id: "pane:2",
                        workspaceId: "workspace:1",
                        preview: `I looked it up: the session is ${SESSION_A}, on the martin account.`,
                    }),
                    pane({ id: "pane:33", workspaceId: "workspace:11", preview: resumeScreen(SESSION_A) }),
                ],
                [
                    { id: "workspace:1", name: "DevDashboard" },
                    { id: "workspace:11", name: "GenesisTools" },
                ]
            ),
            SESSION_A
        );

        expect(targets).toHaveLength(2);
        expect(targets[0].paneId).toBe("pane:33");
        expect(targets[0].matchedOn).toBe("resume-command");
        expect(targets[1].matchedOn).toBe("session-id");
        expect(isUnambiguous(targets)).toBe(true);
    });

    test("resume detection accepts unquoted and = forms", () => {
        expect(resumedSessionIdsIn(`claude --resume ${SESSION_A}`)).toEqual([SESSION_A]);
        expect(resumedSessionIdsIn(`claude --resume="${SESSION_A}"`)).toEqual([SESSION_A]);
        expect(resumedSessionIdsIn(`the id is ${SESSION_A}`)).toEqual([]);
    });

    test("matches a pane title, a workspace name and a cwd", () => {
        const panes = [pane({ id: "pane:33", workspaceId: "workspace:11", title: "vitest", cwd: "/repo/api" })];

        expect(findFocusTargets(snapshot(panes), "vitest")[0].matchedOn).toBe("pane-title");
        expect(findFocusTargets(snapshot(panes), "GenesisTools")[0].matchedOn).toBe("workspace");
        expect(findFocusTargets(snapshot(panes), "api")[0].matchedOn).toBe("cwd");
    });

    test("searches surface titles and surface screens, not only the pane preview", () => {
        const targets = findFocusTargets(
            snapshot([
                pane({
                    id: "pane:33",
                    workspaceId: "workspace:11",
                    surfaces: [
                        {
                            id: "surface:45",
                            title: "tab two",
                            type: "terminal",
                            index: 1,
                            selected: false,
                            active: false,
                            preview: resumeScreen(SESSION_B),
                        },
                    ],
                }),
            ]),
            SESSION_B
        );

        expect(targets).toHaveLength(1);
        expect(targets[0].matchedOn).toBe("resume-command");
    });

    test("an active pane wins a score tie", () => {
        const targets = findFocusTargets(
            snapshot([
                pane({ id: "pane:33", workspaceId: "workspace:11", title: "build" }),
                pane({ id: "pane:34", workspaceId: "workspace:11", title: "build", active: true }),
            ]),
            "build"
        );

        expect(targets[0].paneId).toBe("pane:34");
    });

    test("excludePaneId drops the calling pane, so a query cannot match itself", () => {
        // The live bug: running `focus zzz-not-a-session` from a cmux pane put that string
        // on the caller's screen, the weak text rule matched it, and the command reported a
        // confident hit and focused the pane it was typed in.
        const panes = [
            pane({ id: "pane:2", workspaceId: "workspace:1", preview: "$ tools claude cmux focus zzz-nope" }),
        ];

        expect(findFocusTargets(snapshot(panes), "zzz-nope")).toHaveLength(1);
        expect(findFocusTargets(snapshot(panes), "zzz-nope", { excludePaneId: "pane:2" })).toEqual([]);
    });

    test("excludePaneId leaves other panes alone", () => {
        const panes = [
            pane({ id: "pane:2", workspaceId: "workspace:1", preview: "$ tools claude cmux focus abc" }),
            pane({ id: "pane:33", workspaceId: "workspace:11", preview: resumeScreen(SESSION_A) }),
        ];
        const targets = findFocusTargets(snapshot(panes), SESSION_A, { excludePaneId: "pane:2" });

        expect(targets).toHaveLength(1);
        expect(targets[0].paneId).toBe("pane:33");
    });

    test("an untitled session matches a tab named from its prompt file stem", () => {
        // Live 4691ef7b: no customTitle, first prompt cites clauderoo-cwd-slowdown.html,
        // cmux tab is "◑ Clauderoo cwd slowdown" with no ` · 4691ef7b` suffix and no
        // --resume line still on screen (previews=none). Id-only focus returned no match.
        const targets = findFocusTargets(
            snapshot([
                pane({
                    id: "pane:1",
                    workspaceId: "workspace:11",
                    title: "pane:1",
                    preview: busyTuiScreen(),
                    surfaces: [
                        {
                            id: "surface:124",
                            title: "◑ Clauderoo cwd slowdown",
                            type: "terminal",
                            index: 0,
                            selected: true,
                            active: true,
                        },
                    ],
                }),
            ]),
            "4691ef7b",
            { aliases: ["clauderoo cwd slowdown"] }
        );

        expect(targets).toHaveLength(1);
        expect(targets[0].paneId).toBe("pane:1");
        expect(targets[0].surfaceId).toBe("surface:124");
        expect(targets[0].matchedOn).toBe("session-name");
    });

    test("a session-name match still reports the queried session id", () => {
        // Live: focus 4691ef7b landed on the Clauderoo tab (statusline AC 4691ef7b)
        // but printed "no session" because previews=none left sessionIds empty.
        const sessionId = "4691ef7b-0ab5-4f05-8513-e7b118f05f50";
        const targets = findFocusTargets(
            snapshot([
                pane({
                    id: "pane:1",
                    workspaceId: "workspace:11",
                    title: "pane:1",
                    preview: busyTuiScreen(),
                    surfaces: [
                        {
                            id: "surface:124",
                            title: "◑ Clauderoo cwd slowdown",
                            type: "terminal",
                            index: 0,
                            selected: true,
                            active: true,
                        },
                    ],
                }),
            ]),
            "4691ef7b",
            { aliases: ["clauderoo cwd slowdown"], resolvedSessionId: sessionId }
        );

        expect(targets[0].sessionIds).toEqual([sessionId]);
    });

    test("a /rename title matches the OSC tab even with an activity prefix", () => {
        const title = "abc-123456-234567-pr-1234-logouts-newest-invesgitations-redirect-loop";
        const targets = findFocusTargets(
            snapshot([
                pane({
                    id: "pane:35",
                    workspaceId: "workspace:11",
                    title: "pane:35",
                    preview: busyTuiScreen(),
                    surfaces: [
                        {
                            id: "surface:57",
                            title: `✳ ${title}`,
                            type: "terminal",
                            index: 0,
                            selected: false,
                            active: false,
                        },
                        {
                            id: "surface:38",
                            title: "✳ abc-123456-234567-pr-1234-logouts-newest-invesgitations",
                            type: "terminal",
                            index: 1,
                            selected: true,
                            active: false,
                        },
                    ],
                }),
            ]),
            "c53c4440",
            { aliases: [title] }
        );

        expect(targets[0].surfaceId).toBe("surface:57");
        expect(targets[0].matchedOn).toBe("session-name");
    });

    test("a full id still finds a busy pane whose resume command has scrolled away", () => {
        // cmux only exposes the visible viewport, so an active Claude TUI displaces the
        // `--resume <uuid>` line within seconds. Before this, `focus <full-uuid>` reported
        // no match for exactly the long-running sessions you most want to jump to.
        const targets = findFocusTargets(
            snapshot([
                pane({
                    id: "pane:33",
                    workspaceId: "workspace:11",
                    title: restoredTitle(SESSION_A),
                    preview: busyTuiScreen(),
                }),
            ]),
            SESSION_A
        );

        expect(targets).toHaveLength(1);
        expect(targets[0].matchedOn).toBe("title-id");
    });

    test("the tab-title id beats a pane that only printed the id, with no prompt", () => {
        const targets = findFocusTargets(
            snapshot([
                pane({ id: "pane:2", workspaceId: "workspace:11", preview: `the session is ${SESSION_A}` }),
                pane({
                    id: "pane:33",
                    workspaceId: "workspace:11",
                    title: restoredTitle(SESSION_A),
                    preview: busyTuiScreen(),
                }),
            ]),
            SESSION_A
        );

        expect(targets[0].paneId).toBe("pane:33");
        expect(targets[0].matchedOn).toBe("title-id");
        expect(isUnambiguous(targets)).toBe(true);
    });

    test("a tab-title id only matches queries at least 8 characters long", () => {
        const panes = [
            pane({ id: "pane:33", workspaceId: "workspace:11", title: restoredTitle(SESSION_A), preview: "" }),
        ];

        expect(findFocusTargets(snapshot(panes), SESSION_A.slice(0, 8))[0].matchedOn).toBe("title-id");
        expect(findFocusTargets(snapshot(panes), SESSION_A.slice(0, 7))[0].matchedOn).toBe("pane-title");
    });

    test("the MATCHED tab's session is reported, not the visible tab's", () => {
        // Two resumed surfaces in one pane. Ordering session ids by scope alone would put
        // the selected tab's session first, so the status line, the picker hint and the JSON
        // would all name session A while the command focuses B's tab.
        const targets = findFocusTargets(
            snapshot([
                pane({
                    id: "pane:33",
                    workspaceId: "workspace:11",
                    surfaces: [
                        surface({ id: "surface:45", selected: true, preview: resumeScreen(SESSION_A) }),
                        surface({ id: "surface:46", preview: resumeScreen(SESSION_B) }),
                    ],
                }),
            ]),
            SESSION_B
        );

        expect(targets[0].surfaceId).toBe("surface:46");
        expect(targets[0].sessionIds[0]).toBe(SESSION_B);
        // Still a full inventory of the pane, just ordered by what matched.
        expect(targets[0].sessionIds).toContain(SESSION_A);
    });

    test("a match on a background tab carries that surface, so the caller can raise it", () => {
        const targets = findFocusTargets(
            snapshot([
                pane({
                    id: "pane:33",
                    workspaceId: "workspace:11",
                    preview: "some other tab's output",
                    surfaces: [
                        surface({ id: "surface:45", selected: true, title: "zsh" }),
                        surface({ id: "surface:46", title: "hidden", preview: resumeScreen(SESSION_A) }),
                    ],
                }),
            ]),
            SESSION_A
        );

        expect(targets[0].matchedOn).toBe("resume-command");
        expect(targets[0].surfaceId).toBe("surface:46");
    });

    test("a match on the pane's own text carries no surface, so no tab gets switched", () => {
        const targets = findFocusTargets(
            snapshot([
                pane({
                    id: "pane:33",
                    workspaceId: "workspace:11",
                    preview: resumeScreen(SESSION_A),
                    surfaces: [surface({ id: "surface:45", selected: true, preview: resumeScreen(SESSION_A) })],
                }),
            ]),
            SESSION_A
        );

        expect(targets[0].surfaceId).toBeUndefined();
    });

    test("the visible tab wins a tie against a background tab", () => {
        const targets = findFocusTargets(
            snapshot([
                pane({
                    id: "pane:33",
                    workspaceId: "workspace:11",
                    surfaces: [
                        surface({ id: "surface:46", title: "build" }),
                        surface({ id: "surface:45", selected: true, title: "build" }),
                    ],
                }),
            ]),
            "build"
        );

        expect(targets[0].surfaceId).toBe("surface:45");
    });

    test("an empty or whitespace query matches nothing", () => {
        const panes = [pane({ id: "pane:33", workspaceId: "workspace:11", preview: resumeScreen(SESSION_A) })];

        expect(findFocusTargets(snapshot(panes), "")).toEqual([]);
        expect(findFocusTargets(snapshot(panes), "   ")).toEqual([]);
    });

    test("falls back to the workspace id when the workspace has no name entry", () => {
        const targets = findFocusTargets(
            snapshot([pane({ id: "pane:1", workspaceId: "workspace:99", title: "build" })], []),
            "build"
        );

        expect(targets[0].workspaceName).toBe("workspace:99");
    });
});

describe("aliasesForSession", () => {
    test("custom title beats the prompt", () => {
        expect(
            aliasesForSession("c53c4440", [
                {
                    sessionId: "c53c4440-ffd5-41ad-af8e-07bbbbf4a55f",
                    customTitle: "abc-123456-234567-pr-1234-logouts-newest-invesgitations-redirect-loop",
                    summary: null,
                    firstPrompt: "file:///tmp/other.html",
                },
            ])
        ).toEqual(["abc-123456-234567-pr-1234-logouts-newest-invesgitations-redirect-loop"]);
    });

    test("untitled session aliases a file stem from the first prompt", () => {
        // Regression: 4691ef7b has no /rename. The tab is "Clauderoo cwd slowdown"
        // because the prompt cited clauderoo-cwd-slowdown.html.
        expect(
            aliasesForSession("4691ef7b", [
                {
                    sessionId: "4691ef7b-0ab5-4f05-8513-e7b118f05f50",
                    customTitle: null,
                    summary: null,
                    firstPrompt:
                        "pls can you see file:///Users/Martin/projects/notes/clauderoo-cwd-slowdown.html and tell me if its bullshit or wtf is happening?",
                },
            ])
        ).toEqual(["clauderoo-cwd-slowdown", "clauderoo cwd slowdown"]);
    });
});

describe("isUnambiguous", () => {
    test("no matches is not unambiguous", () => {
        expect(isUnambiguous([])).toBe(false);
    });

    test("one match is unambiguous", () => {
        const targets = findFocusTargets(
            snapshot([pane({ id: "pane:33", workspaceId: "workspace:11", preview: resumeScreen(SESSION_A) })]),
            SESSION_A
        );

        expect(isUnambiguous(targets)).toBe(true);
    });

    test("one id match plus weaker text matches is still unambiguous", () => {
        const short = SESSION_A.slice(0, 8);
        const targets = findFocusTargets(
            snapshot([
                // Resuming the session: an id match.
                pane({ id: "pane:33", workspaceId: "workspace:11", preview: resumeScreen(SESSION_A) }),
                // Only mentions the id in its title, e.g. a notes pane. Weaker on purpose.
                pane({ id: "pane:34", workspaceId: "workspace:11", title: `notes ${short}` }),
            ]),
            short
        );

        expect(targets).toHaveLength(2);
        expect(targets[0].paneId).toBe("pane:33");
        expect(targets[0].matchedOn).toBe("resume-prefix");
        expect(targets[1].matchedOn).toBe("pane-title");
        expect(isUnambiguous(targets)).toBe(true);
    });

    test("two panes showing the same id is ambiguous", () => {
        const targets = findFocusTargets(
            snapshot([
                pane({ id: "pane:33", workspaceId: "workspace:11", preview: resumeScreen(SESSION_A) }),
                pane({ id: "pane:34", workspaceId: "workspace:11", preview: resumeScreen(SESSION_A) }),
            ]),
            SESSION_A
        );

        expect(targets).toHaveLength(2);
        expect(isUnambiguous(targets)).toBe(false);
    });

    test("two equal-scoring text matches are ambiguous", () => {
        const targets = findFocusTargets(
            snapshot([
                pane({ id: "pane:33", workspaceId: "workspace:11", title: "build" }),
                pane({ id: "pane:34", workspaceId: "workspace:11", title: "build" }),
            ]),
            "build"
        );

        expect(isUnambiguous(targets)).toBe(false);
    });
});

describe("describeMatch", () => {
    test("names every match kind", () => {
        const kinds = [
            "resume-command",
            "resume-prefix",
            "title-id",
            "session-name",
            "session-id",
            "id-prefix",
            "pane-title",
            "workspace",
            "cwd",
            "screen",
            "tmux",
            "tmux-hidden",
        ] as const;

        for (const kind of kinds) {
            const described = describeMatch({
                workspaceId: "workspace:1",
                workspaceName: "ws",
                paneId: "pane:1",
                paneTitle: "t",
                sessionIds: [],
                matchedOn: kind,
                score: 1,
                active: false,
            });

            expect(described.length).toBeGreaterThan(0);
        }
    });
});

describe("excludeSurfaceId (caller's own tab, not its whole pane)", () => {
    // 2026-08-26: focus for a session sitting one tab away from the caller skipped
    // the caller's ENTIRE pane, then focused a different pane whose tab had a
    // near-identical name — and reported success.
    const callerPane = pane({
        id: "pane:35",
        workspaceId: "workspace:11",
        active: true,
        surfaceCount: 2,
        surfaces: [
            surface({ id: "surface:57", title: restoredTitle(SESSION_A, "abc-logouts-redirect-loop") }),
            surface({ id: "surface:193", title: "martin account usage verification", selected: true }),
        ],
    });

    test("a sibling tab in the caller's own pane is still findable", () => {
        const targets = findFocusTargets(snapshot([callerPane]), SESSION_A.slice(0, 8), {
            excludeSurfaceId: "surface:193",
        });

        expect(targets).toHaveLength(1);
        expect(targets[0].paneId).toBe("pane:35");
        expect(targets[0].surfaceId).toBe("surface:57");
    });

    test("excluding the whole pane hides that sibling — the old behaviour", () => {
        expect(findFocusTargets(snapshot([callerPane]), SESSION_A.slice(0, 8), { excludePaneId: "pane:35" })).toEqual(
            []
        );
    });

    test("the caller's own tab never matches its own echoed query", () => {
        const echoing = pane({
            id: "pane:35",
            workspaceId: "workspace:11",
            surfaceCount: 1,
            surfaces: [
                surface({
                    id: "surface:193",
                    title: "asking about a session",
                    selected: true,
                    preview: `tools claude cmux focus ${SESSION_A}`,
                }),
            ],
        });

        expect(findFocusTargets(snapshot([echoing]), SESSION_A, { excludeSurfaceId: "surface:193" })).toEqual([]);
    });

    test("the pane's own preview goes with the excluded tab when that tab is selected", () => {
        // pane.preview mirrors the SELECTED surface, so keeping it would smuggle the
        // caller's echoed text back in through the pane-level scope.
        const mirrored = pane({
            id: "pane:35",
            workspaceId: "workspace:11",
            preview: `tools claude cmux focus ${SESSION_A}`,
            surfaceCount: 1,
            surfaces: [surface({ id: "surface:193", title: "caller", selected: true })],
        });

        expect(findFocusTargets(snapshot([mirrored]), SESSION_A, { excludeSurfaceId: "surface:193" })).toEqual([]);
    });

    test("a pane whose only surface is excluded contributes nothing", () => {
        const onlyCaller = pane({
            id: "pane:35",
            workspaceId: "workspace:11",
            title: "genesistools",
            surfaceCount: 1,
            surfaces: [surface({ id: "surface:193", title: "genesistools", selected: true })],
        });

        expect(findFocusTargets(snapshot([onlyCaller]), "genesistools", { excludeSurfaceId: "surface:193" })).toEqual(
            []
        );
    });
});

/** The chain a `tools tmux session attach` pane really has, from a live `ps` on 2026-10-11 (paths invented). */
const TMUX_ID = "d2198696-37be-4718-a174-a004d1bbf25b";
const TMUX_PROCESSES: HostProcess[] = [
    { pid: 1, ppid: 0, command: "/sbin/launchd" },
    // The cmux pane: its shell, then the tmux client it runs. Nothing below it is the session.
    { pid: 55786, ppid: 1, command: "-zsh" },
    { pid: 58533, ppid: 55786, command: "gt-tmux /repo/src/tmux/index.ts session attach dd-045c53d3" },
    { pid: 58543, ppid: 58533, command: "/opt/homebrew/bin/tmux attach-session -t dd-045c53d3" },
    // The tmux server keeps the argv of the client that started it, and every pane is its child.
    { pid: 44217, ppid: 1, command: "/opt/homebrew/bin/tmux new-session -d -s dd-915d3265 -c /repo -- /bin/zsh" },
    { pid: 79917, ppid: 44217, command: "/bin/zsh" },
    { pid: 80001, ppid: 79917, command: "bun run /repo/src/claude/index.ts run work --resume missed-calls" },
    { pid: 80002, ppid: 80001, command: `zsh -ic exec ccc --resume ${TMUX_ID}` },
    {
        pid: 46112,
        ppid: 80002,
        command: `/home/dev/.bun/bin/claude --dangerously-skip-permissions --resume ${TMUX_ID}`,
    },
    // Another tmux pane where an agent only searches for the id: not the session.
    { pid: 79918, ppid: 44217, command: "/bin/zsh" },
    { pid: 90001, ppid: 79918, command: `rg ${TMUX_ID}` },
    // A session run straight in a cmux pane, under no tmux at all.
    { pid: 70001, ppid: 55786, command: `claude --resume ${SESSION_A}` },
];

/** No agent and no registry entry: the only process naming TMUX_ID is another program with a resume-shaped argument. */
const UNRELATED_RESUME: HostProcess[] = [
    ...TMUX_PROCESSES.filter((proc) => proc.pid !== 80002 && proc.pid !== 46112),
    { pid: 90002, ppid: 79918, command: `python job.py resume ${TMUX_ID}` },
];

function tmuxDeps(overrides: {
    processes?: HostProcess[];
    registry?: Map<number, string>;
    panes?: TmuxPaneInfo[];
    clients?: TmuxClientInfo[];
    sockets?: (TmuxSocket | undefined)[];
}): TmuxHostDeps {
    return {
        listProcesses: async () => overrides.processes ?? TMUX_PROCESSES,
        readRegistry: () => overrides.registry ?? new Map([[46112, TMUX_ID]]),
        listPanes: async (socket) => {
            overrides.sockets?.push(socket);
            return {
                ok: true,
                items: overrides.panes ?? [
                    {
                        pane: "%200",
                        session: "dd-045c53d3",
                        tty: "/dev/ttys040",
                        sessionCreatedMs: 0,
                        visible: true,
                        panePid: 79917,
                    },
                    {
                        pane: "%201",
                        session: "dd-045c53d3",
                        tty: "/dev/ttys041",
                        sessionCreatedMs: 0,
                        visible: false,
                        panePid: 79918,
                    },
                ],
            };
        },
        listClients: async () => ({
            ok: true,
            items: overrides.clients ?? [{ tty: "/dev/ttys001", session: "dd-045c53d3", pid: 58543 }],
        }),
    };
}

describe("sessionProcessPids", () => {
    test("Claude's registry names the session's process, ahead of any command line", () => {
        expect(sessionProcessPids(TMUX_ID, TMUX_PROCESSES, new Map([[46112, TMUX_ID]]))).toEqual([46112]);
    });

    test("without a live registry entry a resume command counts, a command that only mentions the id does not", () => {
        expect(sessionProcessPids(TMUX_ID, TMUX_PROCESSES, new Map())).toEqual([80002, 46112]);
    });

    test("a resume-shaped argument of a program that is no agent is not evidence", () => {
        expect(sessionProcessPids(TMUX_ID, UNRELATED_RESUME, new Map())).toEqual([]);
    });

    test("a registry pid that now runs something else is gone, and a pid the registry gives another session is not this one", () => {
        const recycled = TMUX_PROCESSES.map((proc) =>
            proc.pid === 46112 ? { ...proc, command: "/usr/bin/vim" } : proc
        );
        expect(sessionProcessPids(TMUX_ID, recycled, new Map([[46112, TMUX_ID]]))).toEqual([80002]);
        // `/resume` inside the TUI moved pid 46112 to another session; its argv still names the old id, and so does
        // the wrapper above it, which now runs SESSION_B's agent and is no evidence for the old id either.
        expect(sessionProcessPids(TMUX_ID, TMUX_PROCESSES, new Map([[46112, SESSION_B]]))).toEqual([]);
        expect(sessionProcessPids(SESSION_B, TMUX_PROCESSES, new Map([[46112, SESSION_B]]))).toEqual([46112]);
    });
});

describe("findTmuxHosts", () => {
    test("a session under a tmux pane finds that pane and the clients attached to its tmux session", async () => {
        const sockets: (TmuxSocket | undefined)[] = [];
        expect(await findTmuxHosts(TMUX_ID, tmuxDeps({ sockets }))).toEqual([
            { session: "dd-045c53d3", pane: "%200", visible: true, clientTtys: ["/dev/ttys001"] },
        ]);
        // The server was started with no socket flag, so the default server is asked.
        expect(sockets).toEqual([undefined]);
    });

    test("a pane whose program only takes a resume-shaped argument is no host to type into", async () => {
        expect(await findTmuxHosts(TMUX_ID, tmuxDeps({ processes: UNRELATED_RESUME, registry: new Map() }))).toEqual(
            []
        );
    });

    test("after a /resume moved the agent to another session, the old id has no tmux pane to type into", async () => {
        const moved = new Map([[46112, SESSION_B]]);

        expect(await findTmuxHosts(TMUX_ID, tmuxDeps({ registry: moved }))).toEqual([]);
        expect(await findTmuxHosts(SESSION_B, tmuxDeps({ registry: moved }))).toEqual([
            { session: "dd-045c53d3", pane: "%200", visible: true, clientTtys: ["/dev/ttys001"] },
        ]);
    });

    test("a session outside tmux asks tmux nothing", async () => {
        const sockets: (TmuxSocket | undefined)[] = [];
        expect(await findTmuxHosts(SESSION_A, tmuxDeps({ registry: new Map(), sockets }))).toEqual([]);
        expect(sockets).toEqual([]);
    });

    test("a server on its own socket is asked on that socket", async () => {
        const sockets: (TmuxSocket | undefined)[] = [];
        const processes = TMUX_PROCESSES.map((proc) =>
            proc.pid === 44217 ? { ...proc, command: "tmux -L agents new-session -d -s dd-045c53d3" } : proc
        );
        const hosts = await findTmuxHosts(TMUX_ID, tmuxDeps({ processes, sockets }));

        expect(sockets).toEqual([{ flag: "-L", value: "agents" }]);
        expect(hosts[0]?.socket).toEqual({ flag: "-L", value: "agents" });
    });
});

describe.skipIf(process.platform !== "darwin")("findAllTmuxHosts on the live process table", () => {
    test("finds a session whose process runs under a process named tmux, through the default process listing", async () => {
        // bash forks `claude` (a renamed sleep), prints its pid, then becomes `tmux`: the claude's parent.
        const server = Bun.spawn(
            ["/bin/bash", "-c", "(exec -a claude /bin/sleep 30) & echo $!; exec -a tmux /bin/sleep 30"],
            { env: process.env, stdin: "ignore", stdout: "pipe", stderr: "ignore" }
        );
        const { value } = await server.stdout.getReader().read();
        const claudePid = Number(new TextDecoder().decode(value).trim());
        const sessionId = "0c0ffee0-0000-4000-8000-00000000c1a5";

        try {
            // bash execs the server after printing; wait until the parent's command line is `tmux`.
            const deadline = Date.now() + 5_000;

            while (
                !Bun.spawnSync(["ps", "-o", "command=", "-p", String(server.pid)], { env: process.env })
                    .stdout.toString()
                    .startsWith("tmux")
            ) {
                if (Date.now() > deadline) {
                    throw new Error("the fake tmux server never exec'd");
                }

                await Bun.sleep(20);
            }

            const spawn = spyOn(Bun, "spawn");
            let hosts = new Map<string, TmuxHost[]>();
            let spawned = -1;

            try {
                hosts = await findAllTmuxHosts({
                    readRegistry: () => new Map([[claudePid, sessionId]]),
                    listPanes: async () => ({
                        ok: true,
                        items: [
                            {
                                pane: "%9",
                                session: "probe",
                                tty: "/dev/ttys999",
                                sessionCreatedMs: 0,
                                visible: true,
                                panePid: claudePid,
                            },
                        ],
                    }),
                    listClients: async () => ({
                        ok: true,
                        items: [{ tty: "/dev/ttys998", session: "probe", pid: 1 }],
                    }),
                });
                spawned = spawn.mock.calls.length;
            } finally {
                spawn.mockRestore();
            }

            expect(Object.fromEntries(hosts)).toEqual({
                [sessionId]: [{ session: "probe", pane: "%9", visible: true, clientTtys: ["/dev/ttys998"] }],
            });
            // The process table came from the kernel, not from a `ps` child.
            expect(spawned).toBe(0);
        } finally {
            process.kill(claudePid);
            server.kill();
            await server.exited;
        }
    });
});

describe("tmuxAttachCommand", () => {
    const host = (session: string, socket?: TmuxSocket): TmuxHost => ({
        session,
        pane: "%1",
        visible: true,
        clientTtys: [],
        socket,
    });

    test("an ordinary name stays bare, with or without a socket", () => {
        expect(tmuxAttachCommand(host("dd-045c53d3"))).toBe("tools tmux session attach dd-045c53d3");
        expect(tmuxAttachCommand(host("dd", { flag: "-L", value: "agents" }))).toBe("tmux -L agents attach -t dd");
    });

    test("a name or socket with a space or shell syntax is quoted, so a pasted command runs only the attach", () => {
        expect(tmuxAttachCommand(host("my work"))).toBe("tools tmux session attach 'my work'");
        expect(tmuxAttachCommand(host("a;rm x", { flag: "-S", value: "/tmp/my dir/sock" }))).toBe(
            "tmux -S '/tmp/my dir/sock' attach -t 'a;rm x'"
        );
    });
});

describe("findSessionTargets through tmux", () => {
    const attachedPane = pane({
        id: "pane:1",
        workspaceId: "workspace:11",
        title: "tools tmux session attach dd-045c53d3",
        cwd: "/repo",
        surfaces: [
            surface({ id: "surface:1", title: "notes", selected: true, tty: "ttys009" }),
            surface({ id: "surface:2", title: "tools tmux session attach dd-045c53d3", tty: "ttys001" }),
        ],
    });
    const secondClientPane = pane({
        id: "pane:2",
        workspaceId: "workspace:11",
        title: "tmux attach -t dd-045c53d3",
        surfaces: [surface({ id: "surface:3", selected: true, tty: "ttys002" })],
    });
    const sameFolderPane = pane({
        id: "pane:3",
        workspaceId: "workspace:11",
        cwd: "/repo",
        surfaces: [surface({ id: "surface:4", selected: true, tty: "ttys003" })],
    });

    function deps(view: CmuxLiveSnapshot, hosts: TmuxHost[]): ResolveDeps {
        return {
            identify: async () => undefined,
            fetchSnapshot: async () => view,
            lookupSession: async () => ({ aliases: [], sessionId: TMUX_ID, cwd: "/repo" }),
            lookupRefs: () => null,
            tmuxHosts: async () => hosts,
        };
    }

    const onScreen: TmuxHost = { session: "dd-045c53d3", pane: "%200", visible: true, clientTtys: ["/dev/ttys001"] };

    test("a session in tmux resolves to the cmux pane whose tab runs the tmux client", async () => {
        const result = await findSessionTargets(TMUX_ID, {
            deps: deps(snapshot([sameFolderPane, attachedPane]), [onScreen]),
        });

        expect(result.source).toBe("tmux");
        expect(result.targets.map((target) => [target.paneId, target.surfaceId, target.matchedOn])).toEqual([
            ["pane:1", "surface:2", "tmux"],
        ]);
        expect(result.targets[0]?.sessionIds).toEqual([TMUX_ID]);
        expect(describeMatch(result.targets[0])).toBe("via tmux dd-045c53d3");
        expect(identifiesExactSession(result)).toBe(true);
    });

    test("a session in a plain cmux pane resolves as before", async () => {
        const direct = pane({
            id: "pane:4",
            workspaceId: "workspace:11",
            surfaces: [surface({ id: "surface:5", title: restoredTitle(SESSION_A), selected: true, tty: "ttys004" })],
        });
        const result = await findSessionTargets(SESSION_A, {
            deps: {
                ...deps(snapshot([direct]), []),
                lookupSession: async () => ({ aliases: [], sessionId: SESSION_A }),
            },
        });

        expect(result.source).toBe("titles");
        expect(result.targets.map((target) => [target.paneId, target.matchedOn])).toEqual([["pane:4", "title-id"]]);
        expect(result.tmuxHosts).toBeUndefined();
    });

    test("a tmux session no cmux pane is attached to matches nothing, says why, and skips the folder fallback", async () => {
        const detached: TmuxHost = { ...onScreen, clientTtys: [] };
        const result = await findSessionTargets(TMUX_ID, { deps: deps(snapshot([sameFolderPane]), [detached]) });

        expect(result.targets).toEqual([]);
        expect(result.source).toBe("none");
        expect(tmuxMissHint(result)).toBe(
            "It runs in tmux session dd-045c53d3 (pane %200), and no client is attached to it. Attach it in a cmux pane: tools tmux session attach dd-045c53d3"
        );
    });

    test("two clients in two cmux panes are two targets, and neither is picked on its own", async () => {
        const twoClients: TmuxHost = { ...onScreen, clientTtys: ["/dev/ttys001", "/dev/ttys002"] };
        const result = await findSessionTargets(TMUX_ID, {
            deps: deps(snapshot([attachedPane, secondClientPane]), [twoClients]),
        });

        expect(result.targets.map((target) => [target.paneId, target.surfaceId])).toEqual([
            ["pane:1", "surface:2"],
            ["pane:2", "surface:3"],
        ]);
        expect(isUnambiguous(result.targets)).toBe(false);
        expect(identifiesExactSession(result)).toBe(false);
    });

    test("two clients in two tabs of one cmux pane are two targets as well, and neither is picked on its own", async () => {
        const twoTabs = pane({
            id: "pane:1",
            workspaceId: "workspace:11",
            title: "tools tmux session attach dd-045c53d3",
            cwd: "/repo",
            surfaces: [
                surface({
                    id: "surface:1",
                    title: "tools tmux session attach dd-045c53d3",
                    selected: true,
                    tty: "ttys001",
                }),
                surface({ id: "surface:2", title: "tmux attach -t dd-045c53d3", tty: "ttys002" }),
            ],
        });
        const twoClients: TmuxHost = { ...onScreen, clientTtys: ["/dev/ttys001", "/dev/ttys002"] };
        const result = await findSessionTargets(TMUX_ID, { deps: deps(snapshot([twoTabs]), [twoClients]) });

        expect(result.targets.map((target) => [target.paneId, target.surfaceId])).toEqual([
            ["pane:1", "surface:1"],
            ["pane:1", "surface:2"],
        ]);
        expect(isUnambiguous(result.targets)).toBe(false);
        expect(identifiesExactSession(result)).toBe(false);
    });

    test("a session whose tmux pane is not on screen is found, but is not an exact match to type into", () => {
        const offScreen: TmuxHost = { ...onScreen, visible: false };
        const [target] = tmuxHostTargets(snapshot([attachedPane]), [offScreen], TMUX_ID);

        expect(target?.matchedOn).toBe("tmux-hidden");
        expect(describeMatch(target)).toBe("via tmux dd-045c53d3 (its pane %200 is not on screen)");
        expect(identifiesExactSession({ targets: [target], source: "tmux", unavailable: false })).toBe(false);
    });
});

describe("tmuxCmuxLocations", () => {
    /** `cmux --id-format both tree --all --json`, trimmed to the fields the join reads. */
    const tree = {
        windows: [
            {
                ref: "window:1",
                workspaces: [
                    {
                        ref: "workspace:1",
                        id: "WS-UUID",
                        panes: [
                            {
                                ref: "pane:1",
                                surfaces: [
                                    { ref: "surface:1", id: "S1-UUID", type: "terminal", tty: "ttys009" },
                                    {
                                        ref: "surface:2",
                                        id: "S2-UUID",
                                        type: "terminal",
                                        tty: "ttys001",
                                        pane_ref: "pane:1",
                                    },
                                    { ref: "surface:3", id: "S3-UUID", type: "browser" },
                                ],
                            },
                        ],
                    },
                ],
            },
        ],
    };

    test("a tmux-hosted session gets the location of the cmux tab its tmux client runs in", async () => {
        const locations = await tmuxCmuxLocations({ ...tmuxDeps({}), readTree: async () => tree, now: 42 });

        expect([...locations]).toEqual([
            [
                TMUX_ID,
                {
                    workspaceId: "WS-UUID",
                    workspaceRef: "workspace:1",
                    paneRef: "pane:1",
                    surfaceId: "S2-UUID",
                    surfaceRef: "surface:2",
                    windowRef: "window:1",
                    at: 42,
                },
            ],
        ]);
    });

    test("cmux is not asked when no tmux-hosted session has a client", async () => {
        let asked = 0;
        const locations = await tmuxCmuxLocations({
            ...tmuxDeps({ clients: [] }),
            readTree: async () => {
                asked++;
                return tree;
            },
        });

        expect(locations.size).toBe(0);
        expect(asked).toBe(0);
    });
});
