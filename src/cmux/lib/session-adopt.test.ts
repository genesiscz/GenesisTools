import { expect, test } from "bun:test";
import type { SessionCmuxRefs } from "@genesiscz/utils/cmux/session-refs";
import { SafeJSON } from "@genesiscz/utils/json";
import { liveAgentSurfaces, matchLiveAgentSurfaces, parseCmuxTree, pickAdoptable, ttyRunsAgent } from "./session-adopt";

/** An invented surface UUID per ref, so a journal entry and the tree agree unless a test says otherwise. */
function uuidOf(ref: string): string {
    return `uuid-${ref}`;
}

function surface(ref: string, tty: string) {
    return { ref, id: uuidOf(ref), tty, type: "terminal", title: "t" };
}

const TREE = SafeJSON.stringify({
    caller: { surface_ref: "surface:1" },
    windows: [
        {
            ref: "window:1",
            workspaces: [
                { ref: "workspace:1", panes: [{ surfaces: [surface("surface:1", "ttys001")] }] },
                {
                    ref: "workspace:2",
                    panes: [
                        { surfaces: [surface("surface:5", "ttys005")] },
                        { surfaces: [surface("surface:6", "ttys006")] },
                    ],
                },
            ],
        },
    ],
});

function refs(
    sessionId: string,
    surfaceRef: string,
    at: number,
    provider?: "claude" | "codex" | "grok",
    surfaceId: string | null = uuidOf(surfaceRef)
): SessionCmuxRefs {
    return {
        sessionId,
        ...(provider ? { provider } : {}),
        workspaceId: null,
        surfaceId,
        workspaceRef: null,
        paneRef: null,
        surfaceRef,
        windowRef: null,
        tmuxPane: null,
        cwd: "/repo/work",
        at,
    };
}

const tree = parseCmuxTree(TREE);
const providerOf = (entry: SessionCmuxRefs) => entry.provider;

test("the tree gives each terminal surface its tty, workspace and window, and names the caller", () => {
    expect(tree.caller).toBe("surface:1");
    expect(tree.surfaces.get("surface:6")).toEqual({
        ref: "surface:6",
        id: "uuid-surface:6",
        tty: "ttys006",
        workspace: "workspace:2",
        window: "window:1",
        title: "t",
        workspaceTitle: null,
    });
});

test("a live agent session is found by part of its tab title, workspace title or cwd folder", () => {
    const live = liveAgentSurfaces({
        refs: [refs("0199cccc-0000-7000-8000-000000000001", "surface:6", 5, "grok")],
        tree: parseCmuxTree(
            SafeJSON.stringify({
                caller: { surface_ref: "surface:1" },
                windows: [
                    {
                        ref: "window:1",
                        workspaces: [
                            {
                                ref: "workspace:2",
                                title: "cleanup old PRs",
                                panes: [{ surfaces: [{ ...surface("surface:6", "ttys006"), title: "vybava - grok" }] }],
                            },
                        ],
                    },
                ],
            })
        ),
        providerOf,
    });

    expect(matchLiveAgentSurfaces("vybava", "grok", live).map((hit) => hit.sessionId)).toEqual([
        "0199cccc-0000-7000-8000-000000000001",
    ]);
    expect(matchLiveAgentSurfaces("old prs", "grok", live)).toHaveLength(1);
    expect(matchLiveAgentSurfaces("work", "grok", live)).toHaveLength(1);
    expect(matchLiveAgentSurfaces("vybava", "claude", live)).toEqual([]);
});

test("a session id, its prefix or its surface adopts the newest session of a live surface", () => {
    const journal = [
        refs("old-session-0001", "surface:5", 1, "claude"),
        refs("0199aa11-2222-7333-8444-555566667777", "surface:5", 2, "codex"),
        refs("gone-surface-0001", "surface:99", 3, "grok"),
    ];

    const byPrefix = pickAdoptable({ query: "0199aa11", refs: journal, tree, providerOf });
    expect(byPrefix).toMatchObject({ agent: "codex", surface: "surface:5", tty: "ttys005", createdBy: "adopted" });
    expect(pickAdoptable({ query: "surface:5", refs: journal, tree, providerOf })?.sessionId).toBe(
        "0199aa11-2222-7333-8444-555566667777"
    );
    // The older session on the same surface no longer runs there, and a surface cmux lost is never adopted.
    expect(pickAdoptable({ query: "old-session-0001", refs: journal, tree, providerOf })).toBeNull();
    expect(pickAdoptable({ query: "gone-surface-0001", refs: journal, tree, providerOf })).toBeNull();
});

test("the caller's surface, an ambiguous workspace and an agent nobody can name are never adopted", () => {
    const journal = [
        refs("caller-session-01", "surface:1", 5, "claude"),
        refs("first-session-0001", "surface:5", 5, "claude"),
        refs("second-session-001", "surface:6", 5, "grok"),
        refs("untagged-v7-session", "surface:6", 9),
    ];

    expect(pickAdoptable({ query: "caller-session-01", refs: journal, tree, providerOf })).toBeNull();
    expect(pickAdoptable({ query: "workspace:2", refs: journal.slice(0, 3), tree, providerOf })).toBeNull();
    expect(pickAdoptable({ query: "untagged-v7-session", refs: journal, tree, providerOf })).toBeNull();
});

test("a ref that cmux renumbered onto another terminal is never adopted or listed", () => {
    // After a cmux restart, surface:5 is an unrelated terminal: its UUID is not the one the journal holds.
    const stale = [refs("0199dead-0000-7000-8000-000000000001", "surface:5", 7, "claude", "uuid-of-a-closed-surface")];
    const noUuid = [refs("0199dead-0000-7000-8000-000000000002", "surface:6", 7, "grok", null)];

    expect(pickAdoptable({ query: "surface:5", refs: stale, tree, providerOf })).toBeNull();
    expect(pickAdoptable({ query: "0199dead-0000-7000-8000-000000000001", refs: stale, tree, providerOf })).toBeNull();
    expect(pickAdoptable({ query: "surface:6", refs: noUuid, tree, providerOf })).toBeNull();
    expect(liveAgentSurfaces({ refs: [...stale, ...noUuid], tree, providerOf })).toEqual([]);
});

test("a stale entry does not shadow the session whose surface UUID still matches", () => {
    const journal = [
        refs("0199beef-0000-7000-8000-000000000001", "surface:5", 3, "codex"),
        refs("0199dead-0000-7000-8000-000000000003", "surface:5", 9, "claude", "uuid-of-a-closed-surface"),
    ];

    // Negative control: the matching UUID (compared case-insensitively) still adopts.
    expect(pickAdoptable({ query: "surface:5", refs: journal, tree, providerOf })).toMatchObject({
        sessionId: "0199beef-0000-7000-8000-000000000001",
        agent: "codex",
        surface: "surface:5",
    });
    const upper = [refs("0199beef-0000-7000-8000-000000000002", "surface:6", 3, "grok", "UUID-SURFACE:6")];
    expect(liveAgentSurfaces({ refs: upper, tree, providerOf }).map((hit) => hit.sessionId)).toEqual([
        "0199beef-0000-7000-8000-000000000002",
    ]);
});

test("the tty listing matches the agent binary or its tools launcher, not a word inside a path", () => {
    expect(ttyRunsAgent("-zsh\n/opt/homebrew/bin/codex resume x", "codex")).toBe(true);
    expect(ttyRunsAgent("-zsh\nbun /repo/tools grok run work", "grok")).toBe(true);
    expect(ttyRunsAgent("-zsh\nvim /notes/claude-ideas.md", "claude")).toBe(false);
    expect(ttyRunsAgent("-zsh", "claude")).toBe(false);
});
