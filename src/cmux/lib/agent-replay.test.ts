import { describe, expect, test } from "bun:test";
import {
    inferLauncherFromTitle,
    matchGrokSession,
    type ReplayCatalog,
    type ReplayCatalogSession,
    replayCommandForSurface,
    withInferredReplayCommands,
} from "@app/cmux/lib/agent-replay";
import type { Profile, TerminalSurface } from "@app/cmux/lib/types";
import { PROFILE_VERSION } from "@app/cmux/lib/types";

const GROK_ID = "01a05cc5-0ecf-7d40-945e-977e45b3f935";
const CLAUDE_ID = "6bdfb457-cee9-4202-8105-21be8a801757";

function grokSession(overrides: Partial<ReplayCatalogSession> = {}): ReplayCatalogSession {
    return {
        kind: "grok",
        sessionId: GROK_ID,
        cwd: "/Users/me/Projects/shop",
        title: "PRs merged into release/2026-09-03",
        ...overrides,
    };
}

function claudeSession(overrides: Partial<ReplayCatalogSession> = {}): ReplayCatalogSession {
    return {
        kind: "claude",
        sessionId: CLAUDE_ID,
        cwd: "/Users/me/Projects/App",
        title: "Continue",
        account: "work",
        ...overrides,
    };
}

function catalog(sessions: ReplayCatalogSession[]): ReplayCatalog {
    return { sessions };
}

function terminal(title: string, extra: Partial<TerminalSurface> = {}): TerminalSurface {
    return {
        type: "terminal",
        title,
        cwd: extra.cwd ?? "/Users/me/Projects/shop",
        ...extra,
    };
}

describe("inferLauncherFromTitle", () => {
    test("detects a grok tab even when the live title has a spinner prefix", () => {
        expect(inferLauncherFromTitle("PRs merged into release/2026-09-03 - grok")).toBe("grok");
        expect(inferLauncherFromTitle("project-notes - grok · 33a9c763")).toBe("grok");
        expect(inferLauncherFromTitle("⠙ - Waiting for response… - Restore cmux surfaces - grok")).toBe("grok");
    });

    test("detects Claude Code tabs from the working/idle glyphs", () => {
        expect(inferLauncherFromTitle("✳ Continue")).toBe("claude");
        expect(inferLauncherFromTitle("⠐ Task list h_szhk85zs")).toBe("claude");
        expect(inferLauncherFromTitle("✳ auth-callback · 46768bb6")).toBe("claude");
    });

    test("detects a codex tab from the same suffix shape as grok", () => {
        expect(inferLauncherFromTitle("Fix mcp login - codex")).toBe("codex");
        expect(inferLauncherFromTitle("review-auth - codex · a1523c66")).toBe("codex");
    });

    test("leaves idle shells and other tools alone", () => {
        expect(inferLauncherFromTitle("alice@host:~/Projects/App")).toBeUndefined();
        expect(inferLauncherFromTitle("ncdu /root/security/")).toBeUndefined();
        expect(inferLauncherFromTitle("tail -f /tmp/*.log")).toBeUndefined();
    });
});

describe("matchGrokSession", () => {
    const sessions = [
        grokSession(),
        grokSession({
            sessionId: "01a05d17-c512-7dd2-abb6-e62d8c7d612a",
            title: "Worktree bun installs: Skia copy costs 1.4GB",
        }),
        grokSession({ sessionId: "01a03d56-e4fe-7cd1-aee4-dbe54aaf53b3", title: "aws-costs", cwd: "/other" }),
    ];

    test("matches an exact generated title in the same cwd", () => {
        const hit = matchGrokSession("PRs merged into release/2026-09-03 - grok", "/Users/me/Projects/shop", sessions);
        expect(hit?.sessionId).toBe(GROK_ID);
    });

    test("matches a truncated cmux title against the longer generated title", () => {
        const hit = matchGrokSession(
            "Worktree bun installs: Skia copy costs 1… - grok",
            "/Users/me/Projects/shop",
            sessions
        );
        expect(hit?.sessionId).toBe("01a05d17-c512-7dd2-abb6-e62d8c7d612a");
    });

    test("falls back to a globally unique title when cwd differs", () => {
        const hit = matchGrokSession("aws-costs - grok", "/Users/me/Projects/App", sessions);
        expect(hit?.sessionId).toBe("01a03d56-e4fe-7cd1-aee4-dbe54aaf53b3");
    });

    test("returns nothing for an idle shell title", () => {
        expect(matchGrokSession("alice@host:~/Projects/shop", "/Users/me/Projects/shop", sessions)).toBeUndefined();
    });
});

describe("replayCommandForSurface", () => {
    test("infers grok -r when the profile only saved a cwd (crash offline capture)", () => {
        // Regression test: 2026-09-02 — tools cmux profiles restore crash-20260902-1238
        // only typed `cd` because 30/35 surfaces had no command field.
        const result = replayCommandForSurface(
            terminal("PRs merged into release/2026-09-03 - grok"),
            catalog([grokSession()])
        );
        expect(result?.command).toBe(`grok -r ${GROK_ID}`);
    });

    test("replaces a stale process-table grok -r that belongs to another pane", () => {
        const result = replayCommandForSurface(
            terminal("PRs merged into release/2026-09-03 - grok", {
                command: "grok -r 01a04405-9168-7040-b6e1-3944ff63a604",
            }),
            catalog([grokSession()])
        );
        expect(result?.command).toBe(`grok -r ${GROK_ID}`);
    });

    test("enriches a bare grok capture with the session that matches the tab title", () => {
        const result = replayCommandForSurface(
            terminal("PRs merged into release/2026-09-03 - grok", { command: "grok" }),
            catalog([grokSession()])
        );
        expect(result?.command).toBe(`grok -r ${GROK_ID}`);
    });

    test("infers a Claude resume from an ✳ tab with no saved command", () => {
        const result = replayCommandForSurface(
            terminal("✳ Continue", { cwd: "/Users/me/Projects/App" }),
            catalog([claudeSession()])
        );
        expect(result?.command).toContain("--resume");
        expect(result?.command).toContain(CLAUDE_ID);
        expect(result?.command).not.toMatch(/^cd /);
    });

    test("matches a Claude tab to the session whose first prompt contains the title phrase", () => {
        const result = replayCommandForSurface(
            terminal("✳ Task list h_szhk85zs", { cwd: "/Users/me/Projects/App" }),
            catalog([
                claudeSession({
                    title: "230b3ad0",
                    prompt: "You have been handed a task list. Call the genesis-tools MCP tool",
                    sessionId: "230b3ad0-e4a3-48de-ab54-6f97130aa351",
                }),
            ])
        );
        expect(result?.command).toContain("230b3ad0-e4a3-48de-ab54-6f97130aa351");
    });

    test("does not invent a command for ncdu, ssh, or an idle shell", () => {
        const sessions = catalog([grokSession(), claudeSession()]);
        expect(replayCommandForSurface(terminal("ncdu /root/security/"), sessions)?.command).toBeUndefined();
        expect(replayCommandForSurface(terminal("alice@host:~/Projects/shop"), sessions)?.command).toBeUndefined();
        expect(
            replayCommandForSurface(terminal("-=*[ROOT]*=- | root@de:~ | 125x25 | pts/0"), sessions)?.command
        ).toBeUndefined();
    });

    test("discards a stale grok capture on a Claude tab and infers the Claude resume", () => {
        const result = replayCommandForSurface(
            terminal("✳ Task list h_szhk85zs", {
                cwd: "/Users/me/Projects/App",
                command: "grok",
            }),
            catalog([claudeSession({ title: "Task list h_szhk85zs" })])
        );
        expect(result?.command).toContain(CLAUDE_ID);
        expect(result?.command).toContain("claude");
        expect(result?.command).not.toMatch(/^grok\b/);
    });

    test("does not type grok into a Claude tab when no session matches", () => {
        const result = replayCommandForSurface(
            terminal("✳ Task list h_szhk85zs", { cwd: "/Users/me/Projects/App", command: "grok" }),
            catalog([])
        );
        expect(result?.command).toBeUndefined();
    });

    test("infers a Codex resume from a - codex tab with no saved command", () => {
        const result = replayCommandForSurface(
            terminal("Fix mcp login - codex", { cwd: "/Users/me/Projects/shop" }),
            catalog([
                {
                    kind: "codex",
                    sessionId: "01a067d4-d2b0-7532-8f59-9af2a29c2d0e",
                    cwd: "/Users/me/Projects/shop",
                    title: "Fix mcp login",
                },
            ])
        );
        expect(result?.command).toBe("codex resume 01a067d4-d2b0-7532-8f59-9af2a29c2d0e");
    });

    test("a journal entry never resurrects an agent on a pane that is now a plain shell", () => {
        // The surface ran a Claude session days ago; it is an idle shell now, so
        // there is no agent evidence and nothing may be typed into it.
        const result = replayCommandForSurface(
            terminal("alice@host:~/Projects/shop"),
            catalog([]),
            claudeSession({ title: "alice@host:~/Projects/shop", cwd: "/Users/me/Projects/shop" })
        );
        expect(result.command).toBeUndefined();
    });

    test("the journal's own session id beats a fuzzy title match on another session", () => {
        // Journal says A; an older session B in the same cwd carries the same
        // customTitle under a different account. B used to win, so restore
        // resumed the wrong session under the wrong account.
        const journal = claudeSession({
            sessionId: "aaaaaaaa-1111-4111-8111-111111111111",
            account: "work",
            title: "✳ fix the snapshot bug",
            cwd: "/Users/me/Projects/App",
        });
        const result = replayCommandForSurface(
            terminal("✳ fix the snapshot bug", { cwd: "/Users/me/Projects/App" }),
            catalog([
                claudeSession({
                    sessionId: "bbbbbbbb-2222-4222-8222-222222222222",
                    account: "personal",
                    title: "fix the snapshot bug",
                    cwd: "/Users/me/Projects/App",
                }),
            ]),
            journal
        );
        expect(result.command).toContain("aaaaaaaa-1111-4111-8111-111111111111");
        expect(result.command).toContain("work");
        expect(result.drift.some((d) => d.includes("journal"))).toBe(true);
    });

    test("a Claude journal id is never typed into a grok tab", () => {
        // `refactor the cache layer - grok` is a grok tab; the only session on
        // hand is a Claude one from the surface journal, so nothing is typed.
        const result = replayCommandForSurface(
            terminal("refactor the cache layer - grok"),
            catalog([]),
            claudeSession({ title: "refactor the cache layer - grok" })
        );
        expect(result.command).toBeUndefined();
    });

    test("keeps a non-agent command that was actually captured", () => {
        const result = replayCommandForSurface(
            terminal("vim notes.md", { command: "vim notes.md", command_source: "foreground" }),
            catalog([grokSession()])
        );
        expect(result?.command).toBe("vim notes.md");
    });
});

function profileWith(surfaces: TerminalSurface[]): Profile {
    return {
        version: PROFILE_VERSION,
        name: "crash",
        scope: "all",
        captured_at: "2026-09-02T10:38:00.000Z",
        cmux_version: "offline",
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
                                surfaces,
                            },
                        ],
                    },
                ],
            },
        ],
    };
}

describe("withInferredReplayCommands", () => {
    test("fills missing commands on a saved profile without rewriting non-agent panes", () => {
        const profile = profileWith([
            terminal("PRs merged into release/2026-09-03 - grok"),
            terminal("ncdu /root/security/"),
            terminal("✳ Continue", { cwd: "/Users/me/Projects/App" }),
        ]);

        const enriched = withInferredReplayCommands(profile, catalog([grokSession(), claudeSession()]));
        const surfaces = enriched.windows[0].workspaces[0].panes[0].surfaces;
        const grok = surfaces[0];
        const ncdu = surfaces[1];
        const claude = surfaces[2];

        expect(grok.type).toBe("terminal");
        if (grok.type === "terminal") {
            expect(grok.command).toBe(`grok -r ${GROK_ID}`);
            expect(grok.command_source).toBe("inferred");
        }

        expect(ncdu.type).toBe("terminal");
        if (ncdu.type === "terminal") {
            expect(ncdu.command).toBeUndefined();
        }

        expect(claude.type).toBe("terminal");
        if (claude.type === "terminal") {
            expect(claude.command).toContain(CLAUDE_ID);
            expect(claude.command_source).toBe("inferred");
        }
    });

    test("keeps the session id the saved command already pins over a fuzzy title match", () => {
        // Snapshot pinned session A from the surface journal. Session B carries
        // the same title in the same cwd, so the fuzzy matcher picks B and used
        // to splice B's id into the pane restore types.
        const pinned = "aaaaaaaa-1111-4111-8111-111111111111";
        const decoy = "bbbbbbbb-2222-4222-8222-222222222222";
        const profile = profileWith([
            terminal("✳ fix the snapshot bug", {
                cwd: "/Users/me/Projects/App",
                command: `claude --resume ${pinned}`,
                command_source: "foreground",
            }),
        ]);

        const enriched = withInferredReplayCommands(
            profile,
            catalog([
                claudeSession({
                    sessionId: decoy,
                    title: "fix the snapshot bug",
                    cwd: "/Users/me/Projects/App",
                    account: "personal",
                }),
            ])
        );
        const surface = enriched.windows[0].workspaces[0].panes[0].surfaces[0];

        expect(surface.type).toBe("terminal");
        if (surface.type === "terminal") {
            expect(surface.command).toBe(`claude --resume ${pinned}`);
            expect(surface.command).not.toContain(decoy);
            expect(surface.command_original).toBeUndefined();
        }
    });
});
