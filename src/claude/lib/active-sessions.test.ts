import { describe, expect, test } from "bun:test";
import type { SessionCmuxRefs } from "@app/claude/lib/cmux/session-refs";
import type { ContentBlock } from "@genesiscz/utils/claude/types";
import { SafeJSON } from "@genesiscz/utils/json";
import {
    assignSessionIds,
    buildSessionHints,
    classifyClaudeArgs,
    cleanUserText,
    countSessionInstances,
    extractLaunchDetails,
    humanTextOf,
    invertSurfaceTtys,
    isHelperChild,
    latestRefsBySession,
    parseAccountEnv,
    parseCmuxSurfaceTtys,
    parseLsofCwd,
    parsePsLine,
    parseSessionTail,
} from "./active-sessions";

describe("parsePsLine", () => {
    test("parses pid, ppid, tty, lstart, time and args", () => {
        const line =
            "21384 21277 ttys015 Mon Aug 24 22:16:52 2026      13:52.04 /Users/x/.bun/bin/claude --dangerously-skip-permissions";
        const row = parsePsLine(line);

        expect(row).not.toBeNull();
        expect(row?.pid).toBe(21384);
        expect(row?.ppid).toBe(21277);
        expect(row?.tty).toBe("ttys015");
        expect(row?.cpuTime).toBe("13:52.04");
        expect(row?.args).toBe("/Users/x/.bun/bin/claude --dangerously-skip-permissions");
        expect(row?.startedAt).toBe(Date.parse("Aug 24, 2026 22:16:52"));
    });

    test("rejects short and non-numeric lines", () => {
        expect(parsePsLine("")).toBeNull();
        expect(parsePsLine("garbage line without enough tokens")).toBeNull();
        expect(parsePsLine("abc def ttys001 Mon Aug 24 22:16:52 2026 0:00.01 /bin/claude x")).toBeNull();
    });
});

describe("classifyClaudeArgs", () => {
    test("claude binary is a tui session", () => {
        expect(classifyClaudeArgs("/Users/x/.bun/bin/claude --resume abc")).toBe("tui");
    });

    test("gt-claude wrapper is an sdk session", () => {
        expect(classifyClaudeArgs("/Users/x/.genesis-tools/bin/gt-claude --preload /x/y.ts")).toBe("sdk");
    });

    test("launchers and children are not sessions", () => {
        expect(classifyClaudeArgs("bun run /x/src/claude/index.ts run work")).toBeNull();
        expect(classifyClaudeArgs("bun /x/tools claude mcp")).toBeNull();
        expect(classifyClaudeArgs("/Applications/Some App.app/Contents/MacOS/claude-helper")).toBeNull();
    });
});

describe("extractLaunchDetails", () => {
    test("finds --resume and --model in both forms", () => {
        expect(extractLaunchDetails("/bin/claude --resume 46768bb6-b1 --model claude-opus-5")).toEqual({
            resumeId: "46768bb6-b1",
            model: "claude-opus-5",
        });
        expect(extractLaunchDetails("/bin/claude --resume=abc-123 --model=fable")).toEqual({
            resumeId: "abc-123",
            model: "fable",
        });
    });

    test("returns nulls when absent or malformed", () => {
        expect(extractLaunchDetails("/bin/claude --dangerously-skip-permissions")).toEqual({
            resumeId: null,
            model: null,
        });
        expect(extractLaunchDetails("/bin/claude --resume").resumeId).toBeNull();
    });
});

describe("parseAccountEnv", () => {
    test("plain account name", () => {
        expect(parseAccountEnv("/bin/claude --foo TOOLS_CLAUDE_ACCOUNT=work PATH=/usr/bin")).toEqual({
            account: "work",
            proxyTarget: null,
        });
    });

    test("proxy target", () => {
        expect(parseAccountEnv("/bin/claude TOOLS_CLAUDE_ACCOUNT=proxy:personal/grok")).toEqual({
            account: null,
            proxyTarget: "personal/grok",
        });
    });

    test("missing variable", () => {
        expect(parseAccountEnv("/bin/claude PATH=/usr/bin")).toEqual({ account: null, proxyTarget: null });
    });
});

describe("parseLsofCwd", () => {
    test("maps pid to cwd path", () => {
        const output = "p123\nfcwd\nn/Users/x/proj\np456\nfcwd\nn/tmp/other\n";
        const map = parseLsofCwd(output);

        expect(map.get(123)).toBe("/Users/x/proj");
        expect(map.get(456)).toBe("/tmp/other");
    });
});

describe("assignSessionIds", () => {
    test("--resume claims the id outright", () => {
        const result = assignSessionIds(
            [{ pid: 1, cwd: "/a", resumeId: "sess-1" }],
            [{ sessionId: "sess-1", cwd: "/a" }]
        );

        expect(result.get(1)).toEqual({ sessionId: "sess-1", candidates: 1, source: "resume-arg" });
    });

    test("single active session in a cwd matches the single process there", () => {
        const result = assignSessionIds([{ pid: 1, cwd: "/a", resumeId: null }], [{ sessionId: "sess-1", cwd: "/a" }]);

        expect(result.get(1)).toEqual({ sessionId: "sess-1", candidates: 1, source: "cwd-unique" });
    });

    test("ambiguity stays unresolved with a candidate count", () => {
        const result = assignSessionIds(
            [
                { pid: 1, cwd: "/a", resumeId: null },
                { pid: 2, cwd: "/a", resumeId: null },
            ],
            [
                { sessionId: "sess-1", cwd: "/a" },
                { sessionId: "sess-2", cwd: "/a" },
            ]
        );

        expect(result.get(1)?.sessionId).toBeNull();
        expect(result.get(1)?.candidates).toBe(2);
        expect(result.get(2)?.sessionId).toBeNull();
    });

    test("a resumed sibling releases the remaining candidate", () => {
        const result = assignSessionIds(
            [
                { pid: 1, cwd: "/a", resumeId: "sess-1" },
                { pid: 2, cwd: "/a", resumeId: null },
            ],
            [
                { sessionId: "sess-1", cwd: "/a" },
                { sessionId: "sess-2", cwd: "/a" },
            ]
        );

        expect(result.get(1)?.sessionId).toBe("sess-1");
        expect(result.get(2)).toEqual({ sessionId: "sess-2", candidates: 1, source: "cwd-unique" });
    });
});

describe("cleanUserText", () => {
    test("strips harness wrappers so the real prompt shows", () => {
        expect(cleanUserText("<system-reminder>noise\nmore</system-reminder>fix the bug")).toBe("fix the bug");
        expect(cleanUserText("<task-notification>agent done</task-notification>ok next")).toBe("ok next");
        expect(cleanUserText("<command-name>/rename</command-name>rename it")).toBe("rename it");
    });

    test("collapses whitespace so a row never wraps", () => {
        expect(cleanUserText("line one\n\n  line two")).toBe("line one line two");
    });

    test("a message that is only a wrapper becomes empty", () => {
        expect(cleanUserText("<system-reminder>only noise</system-reminder>")).toBe("");
    });
});

describe("parseSessionTail", () => {
    const line = (obj: Record<string, unknown>) => SafeJSON.stringify(obj);

    test("takes the newest user text and the newest main-thread timestamp", () => {
        const tail = parseSessionTail([
            line({ type: "user", timestamp: "2026-08-26T16:44:00.000Z", message: { content: "older" } }),
            line({ type: "user", timestamp: "2026-08-26T16:44:30.000Z", message: { content: "newest prompt" } }),
            line({ type: "assistant", timestamp: "2026-08-26T16:44:48.000Z", message: { content: [] } }),
        ]);

        expect(tail.lastUserMessage).toBe("newest prompt");
        expect(tail.lastActivityAt).toBe(Date.parse("2026-08-26T16:44:48.000Z"));
    });

    test("subagent traffic never becomes the session's clock", () => {
        const tail = parseSessionTail([
            line({ type: "user", timestamp: "2026-08-26T10:00:00.000Z", message: { content: "real prompt" } }),
            line({
                type: "assistant",
                timestamp: "2026-08-26T18:00:00.000Z",
                isSidechain: true,
                message: { content: [] },
            }),
        ]);

        expect(tail.lastActivityAt).toBe(Date.parse("2026-08-26T10:00:00.000Z"));
        expect(tail.lastUserMessage).toBe("real prompt");
    });

    test("meta and wrapper-only user lines are skipped", () => {
        const tail = parseSessionTail([
            line({ type: "user", timestamp: "2026-08-26T09:00:00.000Z", message: { content: "the real one" } }),
            line({ type: "user", timestamp: "2026-08-26T09:01:00.000Z", isMeta: true, message: { content: "meta" } }),
            line({
                type: "user",
                timestamp: "2026-08-26T09:02:00.000Z",
                message: { content: "<system-reminder>x</system-reminder>" },
            }),
        ]);

        expect(tail.lastUserMessage).toBe("the real one");
    });

    test("malformed lines are skipped, not fatal", () => {
        const tail = parseSessionTail([
            "{not json",
            line({ type: "user", timestamp: "2026-08-26T09:00:00.000Z", message: { content: "survived" } }),
        ]);

        expect(tail.lastUserMessage).toBe("survived");
    });

    test("a transcript with no main-thread turns reports nulls", () => {
        expect(parseSessionTail([line({ type: "file-history-snapshot" })])).toEqual({
            lastUserMessage: null,
            lastActivityAt: null,
        });
    });
});

describe("humanTextOf", () => {
    test("plain string content is the prompt", () => {
        expect(humanTextOf("fix the drain")).toBe("fix the drain");
    });

    test("tool results are NOT the user's message", () => {
        // Every tool return is recorded as a type:"user" record. Treating those as
        // prompts made the who table show "Bash completed with no output".
        expect(
            humanTextOf([
                { type: "tool_result", tool_use_id: "t1", content: "Bash completed with no output" },
            ] as ContentBlock[])
        ).toBe("");
    });

    test("text blocks are kept even when a tool result rides along", () => {
        expect(
            humanTextOf([
                { type: "tool_result", tool_use_id: "t1", content: "stdout noise" },
                { type: "text", text: "now explain it" },
            ] as ContentBlock[])
        ).toBe("now explain it");
    });

    test("missing content is empty, not a crash", () => {
        expect(humanTextOf(undefined)).toBe("");
    });
});

describe("parseSessionTail with tool results", () => {
    test("walks back past tool returns to the real prompt", () => {
        const tail = parseSessionTail([
            SafeJSON.stringify({
                type: "user",
                timestamp: "2026-08-26T18:40:00.000Z",
                message: { content: "explain the drain" },
            }),
            SafeJSON.stringify({
                type: "assistant",
                timestamp: "2026-08-26T18:41:00.000Z",
                message: { content: [{ type: "text", text: "working" }] },
            }),
            SafeJSON.stringify({
                type: "user",
                timestamp: "2026-08-26T18:44:48.000Z",
                message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "no output" }] },
            }),
        ]);

        expect(tail.lastUserMessage).toBe("explain the drain");
        // The clock still advances to the newest main-thread record.
        expect(tail.lastActivityAt).toBe(Date.parse("2026-08-26T18:44:48.000Z"));
    });
});

describe("parseCmuxSurfaceTtys", () => {
    test("reads surface refs and ttys from `cmux top --all`", () => {
        const out = [
            '   2.9%  3.4 GB  31  surface surface:3 [terminal] "col-burn-auth" [selected] tty=ttys000',
            '   1.5%  1.6 GB  20  surface surface:193 [terminal] "claude-bad-session" tty=ttys020',
            "   0.0%  4.8 MB   1  process 21277 zsh",
        ].join("\n");

        const map = parseCmuxSurfaceTtys(out);

        expect(map.get("surface:3")).toBe("ttys000");
        expect(map.get("surface:193")).toBe("ttys020");
        expect(map.size).toBe(2);
    });

    test("a browser surface with no tty is skipped", () => {
        expect(parseCmuxSurfaceTtys('surface surface:9 [browser] "docs"').size).toBe(0);
    });
});

describe("latestRefsBySession", () => {
    test("later journal lines win", () => {
        const raw = [
            SafeJSON.stringify({ sessionId: "s1", surfaceRef: "surface:1", cwd: "/a", at: 100 }),
            SafeJSON.stringify({ sessionId: "s1", surfaceRef: "surface:9", cwd: "/a", at: 200 }),
            "not json",
            SafeJSON.stringify({ sessionId: "s2", surfaceRef: "surface:2", cwd: "/b", at: 150 }),
        ].join("\n");

        const latest = latestRefsBySession(raw);

        expect(latest.get("s1")?.surfaceRef).toBe("surface:9");
        expect(latest.get("s2")?.surfaceRef).toBe("surface:2");
    });
});

describe("buildSessionHints", () => {
    // Typed on purpose: `as never` hid a field rename in SessionCmuxRefs, which
    // is exactly the drift this fixture should catch.
    const refs = new Map<string, SessionCmuxRefs>([
        [
            "s1",
            {
                sessionId: "s1",
                workspaceId: null,
                surfaceId: "UUID-1",
                workspaceRef: null,
                paneRef: null,
                surfaceRef: "surface:1",
                windowRef: null,
                tmuxPane: null,
                cwd: "/a",
                at: 1,
            },
        ],
    ]);

    test("prefers the stable surface UUID over the renumberable ref", () => {
        const hints = buildSessionHints(refs, new Map([["surface:1", "ttys999"]]), new Map([["UUID-1", "ttys001"]]));

        expect(hints).toEqual([{ sessionId: "s1", tty: "ttys001", cwd: "/a" }]);
    });

    test("falls back to the ref when the UUID is unknown to cmux", () => {
        expect(buildSessionHints(refs, new Map([["surface:1", "ttys002"]]))[0].tty).toBe("ttys002");
    });

    test("a session whose surface is gone produces no hint", () => {
        expect(buildSessionHints(refs, new Map())).toEqual([]);
    });
});

describe("assignSessionIds with hook hints", () => {
    test("names a fresh session that has no --resume argument", () => {
        // The whole point: a never-resumed session used to show "—".
        const result = assignSessionIds(
            [{ pid: 1, cwd: "/a", resumeId: null, tty: "ttys020" }],
            [],
            [{ sessionId: "sess-fresh", tty: "ttys020", cwd: "/a" }]
        );

        expect(result.get(1)).toEqual({ sessionId: "sess-fresh", candidates: 1, source: "hook-tty" });
    });

    test("a stale hint pointing at another directory is refused", () => {
        const result = assignSessionIds(
            [{ pid: 1, cwd: "/a", resumeId: null, tty: "ttys020" }],
            [],
            [{ sessionId: "sess-elsewhere", tty: "ttys020", cwd: "/somewhere-else" }]
        );

        expect(result.get(1)?.sessionId).toBeNull();
    });

    test("two hints on one tty means a stale journal — neither is used", () => {
        const result = assignSessionIds(
            [{ pid: 1, cwd: "/a", resumeId: null, tty: "ttys020" }],
            [],
            [
                { sessionId: "sess-old", tty: "ttys020", cwd: "/a" },
                { sessionId: "sess-new", tty: "ttys020", cwd: "/a" },
            ]
        );

        expect(result.get(1)?.sessionId).toBeNull();
    });

    test("an explicit --resume still outranks the hook", () => {
        const result = assignSessionIds(
            [{ pid: 1, cwd: "/a", resumeId: "sess-argv", tty: "ttys020" }],
            [],
            [{ sessionId: "sess-hook", tty: "ttys020", cwd: "/a" }]
        );

        expect(result.get(1)).toEqual({ sessionId: "sess-argv", candidates: 1, source: "resume-arg" });
    });

    test("one session is never assigned to two processes", () => {
        const result = assignSessionIds(
            [
                { pid: 1, cwd: "/a", resumeId: "sess-1", tty: "ttys001" },
                { pid: 2, cwd: "/a", resumeId: null, tty: "ttys002" },
            ],
            [],
            [{ sessionId: "sess-1", tty: "ttys002", cwd: "/a" }]
        );

        expect(result.get(1)?.sessionId).toBe("sess-1");
        expect(result.get(2)?.sessionId).toBeNull();
    });
});

describe("isHelperChild", () => {
    const tui = { kind: "tui" as const, tty: "ttys020" };

    test("an MCP child sharing a TUI's tty is a helper", () => {
        expect(isHelperChild({ kind: "sdk", tty: "ttys020" }, [tui])).toBe(true);
    });

    test("a headless agent with no tty is a real session", () => {
        expect(isHelperChild({ kind: "sdk", tty: "??" }, [tui])).toBe(false);
    });

    test("an SDK session alone on its tty is a real session", () => {
        expect(isHelperChild({ kind: "sdk", tty: "ttys099" }, [tui])).toBe(false);
    });

    test("a TUI is never a helper", () => {
        expect(isHelperChild(tui, [tui])).toBe(false);
    });
});

describe("countSessionInstances", () => {
    test("counts a twice-opened session on both rows", () => {
        const counts = countSessionInstances(["sess-a", "sess-a", "sess-b", null]);

        expect(counts.get("sess-a")).toBe(2);
        expect(counts.get("sess-b")).toBe(1);
        // countSessionInstances never creates a "null" string key, so asserting
        // its absence passed even when null ids WERE counted. Size is the real test.
        expect(counts.size).toBe(2);
    });
});

describe("invertSurfaceTtys", () => {
    test("maps tty back to its surface", () => {
        expect(invertSurfaceTtys(new Map([["surface:3", "ttys000"]])).get("ttys000")).toBe("surface:3");
    });

    test("a tty claimed by two surfaces resolves to neither", () => {
        const map = invertSurfaceTtys(
            new Map([
                ["surface:3", "ttys000"],
                ["surface:9", "ttys000"],
            ])
        );

        expect(map.get("ttys000")).toBe("");
    });
});
