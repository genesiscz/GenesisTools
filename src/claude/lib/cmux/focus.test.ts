import { describe, expect, test } from "bun:test";
import {
    aliasesForSession,
    describeMatch,
    findFocusTargets,
    isUnambiguous,
    paneSessionIds,
    resumedSessionIdsIn,
    sessionIdsIn,
} from "@app/claude/lib/cmux/focus";
import type { CmuxLivePane, CmuxLiveSnapshot, CmuxLiveSurface } from "@genesiscz/utils/cmux/lib/live-snapshot";

const SESSION_A = "8b6e69bf-0efc-4990-ba3e-b77262498421";
const SESSION_B = "f013e93c-a367-46e6-add2-4c026b9cf667";

/** The real shape of a restored pane's screen, copied from a live `cmux read-screen`. */
function resumeScreen(sessionId: string, cwd = "/Users/Martin/Tresors/Projects/GenesisTools"): string {
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

    test("copies windowRef from the live pane so focus can skip identify --workspace", () => {
        const targets = findFocusTargets(
            snapshot([
                pane({
                    id: "pane:33",
                    workspaceId: "workspace:11",
                    windowRef: "window:4",
                    preview: resumeScreen(SESSION_A),
                }),
            ]),
            SESSION_A
        );

        expect(targets[0].windowRef).toBe("window:4");
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
                        preview: `I looked it up: the session is ${SESSION_A}, on the foltyn account.`,
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
        const title = "col-294936-295714-pr-7210-logouts-newest-invesgitations-redirect-loop";
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
                            title: "✳ col-294936-295714-pr-7210-logouts-newest-invesgitations",
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
                    customTitle: "col-294936-295714-pr-7210-logouts-newest-invesgitations-redirect-loop",
                    summary: null,
                    firstPrompt: "file:///tmp/other.html",
                },
            ])
        ).toEqual(["col-294936-295714-pr-7210-logouts-newest-invesgitations-redirect-loop"]);
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
                        "pls can you see file:///Users/Martin/Tresors/Projects/GenesisBrain/GenesisPlayground/clauderoo-cwd-slowdown.html and tell me if its bullshit or wtf is happening?",
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
            surface({ id: "surface:57", title: restoredTitle(SESSION_A, "col-logouts-redirect-loop") }),
            surface({ id: "surface:193", title: "Foltyn account usage verification", selected: true }),
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
