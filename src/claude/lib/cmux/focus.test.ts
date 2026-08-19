import { describe, expect, test } from "bun:test";
import {
    describeMatch,
    findFocusTargets,
    isUnambiguous,
    resumedSessionIdsIn,
    sessionIdsIn,
} from "@app/claude/lib/cmux/focus";
import type { CmuxLivePane, CmuxLiveSnapshot } from "@genesiscz/utils/cmux/lib/live-snapshot";

const SESSION_A = "8b6e69bf-0efc-4990-ba3e-b77262498421";
const SESSION_B = "f013e93c-a367-46e6-add2-4c026b9cf667";

/** The real shape of a restored pane's screen, copied from a live `cmux read-screen`. */
function resumeScreen(sessionId: string, cwd = "/Users/Martin/Tresors/Projects/GenesisTools"): string {
    return `Last login: Wed Aug 19 12:48:46 on ttys025\ncd -- '${cwd}' && tools claude start -- --resume '${sessionId}'`;
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
