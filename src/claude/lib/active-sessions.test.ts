import { describe, expect, mock, spyOn, test } from "bun:test";
import { runWho } from "@app/ai/lib/accounts/run-who";
import { registerWhoCommand } from "@app/claude/commands/who";
import { CODEX_HELPER_KINDS, classifyCodexArgs, codexResumeIdFromArgs } from "@app/codex/lib/process-scan";
import { grokResumeIdFromArgs } from "@app/grok/lib/process-scan";
import type { AgentSearchFilters, AgentSession } from "@genesiscz/utils/agent-sessions/types";
import type { ActiveAgentProcess } from "@genesiscz/utils/ai/active-processes";
import * as processScan from "@genesiscz/utils/ai/active-processes";
import {
    assignSessionIds,
    buildSessionHints,
    countSessionInstances,
    invertSurfaceTtys,
    listActiveAgentSessions,
    parseCmuxTreeTtys,
    sessionsFromAdapter,
    withoutHelpers,
} from "@genesiscz/utils/ai/active-sessions";
import type { ContentBlock } from "@genesiscz/utils/claude/types";
import type { SessionCmuxRefs } from "@genesiscz/utils/cmux/session-refs";
import * as journalRefs from "@genesiscz/utils/cmux/session-refs";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import { Command } from "commander";
import {
    CLAUDE_WHO_SOURCE,
    classifyClaudeArgs,
    cleanUserText,
    extractLaunchDetails,
    humanTextOf,
    isHelperChild,
    parseAccountEnv,
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
        expect(
            classifyClaudeArgs("/Users/x/.genesis-tools/bin/gt-claude /x/src/claude/index.ts start work -- --resume a1")
        ).toBe("sdk");
    });

    test("gt-claude running the stdio mcp server is an mcp helper", () => {
        expect(
            classifyClaudeArgs("/Users/x/.genesis-tools/bin/gt-claude --preload /x/y.ts /x/src/claude/index.ts mcp")
        ).toBe("mcp");
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

describe("parseCmuxTreeTtys", () => {
    const tree = (surfaces: unknown[]) =>
        SafeJSON.stringify({ windows: [{ workspaces: [{ panes: [{ surfaces }] }] }] });

    test("reads each terminal's tty by surface UUID, with its ref for display", () => {
        const { ttyBySurfaceId, refBySurfaceId } = parseCmuxTreeTtys(
            tree([
                { id: "AAAA-0003", ref: "surface:3", type: "terminal", tty: "ttys000" },
                { id: "AAAA-0193", ref: "surface:193", type: "terminal", tty: "ttys020" },
            ])
        );

        expect(ttyBySurfaceId.get("aaaa-0003")).toBe("ttys000");
        expect(ttyBySurfaceId.get("aaaa-0193")).toBe("ttys020");
        expect(refBySurfaceId.get("aaaa-0193")).toBe("surface:193");
        expect(ttyBySurfaceId.size).toBe(2);
    });

    test("a browser surface with no tty is skipped", () => {
        expect(parseCmuxTreeTtys(tree([{ id: "B-9", ref: "surface:9", type: "browser" }])).ttyBySurfaceId.size).toBe(0);
    });
});

// Each agent's own argv names the session it resumes; the shared `who` reads it through the agent's source.
describe("resumeIdFromArgs per agent", () => {
    test("claude, codex and grok each name their resumed session; a new session names none", () => {
        expect(extractLaunchDetails("claude --resume 6bdfb457-cee9-4202-8105-21be8a801757").resumeId).toBe(
            "6bdfb457-cee9-4202-8105-21be8a801757"
        );
        expect(
            codexResumeIdFromArgs("/usr/local/bin/codex -c model=x resume 019a2b3c-0000-7000-8000-000000000001")
        ).toBe("019a2b3c-0000-7000-8000-000000000001");
        expect(codexResumeIdFromArgs("/usr/local/bin/codex")).toBeNull();
        expect(grokResumeIdFromArgs("/Users/me/.local/bin/grok -r 01a1217a-f677-7f60-a597-41ac0ee91bff")).toBe(
            "01a1217a-f677-7f60-a597-41ac0ee91bff"
        );
        expect(grokResumeIdFromArgs("grok --resume=01a1217a-f677")).toBe("01a1217a-f677");
        expect(grokResumeIdFromArgs("grok")).toBeNull();
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

    test("joins by the stable surface UUID, whatever case it is printed in", () => {
        const hints = buildSessionHints(refs, new Map([["uuid-1", "ttys001"]]));

        expect(hints).toEqual([{ sessionId: "s1", tty: "ttys001", cwd: "/a" }]);
    });

    // After a relaunch the record's "surface:1" can be another session's tab.
    test("never joins by the renumberable ref", () => {
        expect(buildSessionHints(refs, new Map([["surface:1", "ttys002"]]))).toEqual([]);
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

    test("an SDK launcher sharing a TUI's tty is a helper", () => {
        expect(isHelperChild({ kind: "sdk", tty: "ttys020" }, [tui])).toBe(true);
    });

    test("an mcp server is a helper even with no tty (Grok/Cursor host)", () => {
        expect(isHelperChild({ kind: "mcp", tty: "??" }, [tui])).toBe(true);
        expect(isHelperChild({ kind: "mcp", tty: "ttys020" }, [tui])).toBe(true);
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
        expect(
            invertSurfaceTtys({
                ttyBySurfaceId: new Map([["u-3", "ttys000"]]),
                refBySurfaceId: new Map([["u-3", "surface:3"]]),
            }).get("ttys000")
        ).toBe("surface:3");
    });

    test("a tty claimed by two surfaces resolves to neither", () => {
        const map = invertSurfaceTtys({
            ttyBySurfaceId: new Map([
                ["u-3", "ttys000"],
                ["u-9", "ttys000"],
            ]),
            refBySurfaceId: new Map(),
        });

        expect(map.get("ttys000")).toBe("");
    });
});

describe("Claude who JSON contract", () => {
    const sessionId = "11111111-1111-4111-8111-111111111111";
    const row: ActiveAgentProcess = {
        pid: 123,
        ppid: 100,
        tty: "ttys001",
        startedAt: 1_700_000_000_000,
        cpuTime: "0:00.01",
        args: "claude",
        kind: "tui",
        account: "work",
        proxyTarget: null,
        cwd: "/repo/fixture",
    };

    async function jsonOutput(input: { entryPoint: string; args: string; extra?: string }): Promise<unknown> {
        const scanned = [{ ...row, args: input.args, extra: input.extra }];
        const scan = spyOn(processScan, "listActiveAgentProcesses").mockResolvedValue(scanned);
        const capture = spyOn(processScan, "runCapture").mockResolvedValue('{"windows":[]}');
        const sessions = spyOn(CLAUDE_WHO_SOURCE, "activeSessions").mockResolvedValue([]);
        const result = spyOn(out, "result").mockImplementation(() => {});

        try {
            if (input.entryPoint === "claude") {
                const program = new Command();
                registerWhoCommand(program);
                await program.parseAsync(["node", "fixture", "who", "--json"]);
            } else {
                await runWho({ json: true });
            }

            expect(result).toHaveBeenCalledTimes(1);
            return result.mock.calls[0]?.[0];
        } finally {
            result.mockRestore();
            sessions.mockRestore();
            capture.mockRestore();
            scan.mockRestore();
        }
    }

    test.each(["claude", "accounts"])("%s who omits argv and unapproved scan fields", async (entryPoint) => {
        const secret = "fixture-sensitive-native-option";
        const output = await jsonOutput({
            entryPoint,
            args: `claude --resume ${sessionId} --api-key ${secret} --print private-fixture-prompt`,
            extra: secret,
        });

        expect(output).toEqual({
            sessions: [
                {
                    pid: row.pid,
                    ppid: row.ppid,
                    tty: row.tty,
                    startedAt: row.startedAt,
                    cpuTime: row.cpuTime,
                    kind: "tui",
                    account: "work",
                    proxyTarget: null,
                    cwd: row.cwd,
                    resumeId: sessionId,
                    model: null,
                    sessionId,
                    sessionCandidates: 1,
                    sessionSource: "resume-arg",
                    surfaceId: null,
                    surfaceRef: null,
                    sessionInstances: 1,
                    sessionTitle: null,
                    lastUserMessage: null,
                    lastActivityAt: null,
                },
            ],
        });
        expect(SafeJSON.stringify(output)).not.toContain(secret);
        expect(SafeJSON.stringify(output)).not.toContain("private-fixture-prompt");
    });

    for (const entryPoint of ["claude", "accounts"]) {
        test.each(["--model fixture-model", "--model=fixture-model", ""])(
            `${entryPoint} who preserves the model field from %j`,
            async (flag) => {
                const output = await jsonOutput({ entryPoint, args: `claude --resume ${sessionId} ${flag}` });
                expect(output).toEqual({
                    sessions: [expect.objectContaining({ model: flag ? "fixture-model" : null })],
                });
            }
        );
    }
});

describe("helper processes cannot claim live sessions", () => {
    test.each(["hook-tty", "cwd-unique"])(
        "a lower-PID Codex helper cannot take the TUI's %s identity",
        async (source) => {
            const sessionId = "11111111-1111-4111-8111-111111111111";
            const tui: ActiveAgentProcess = {
                pid: 101,
                ppid: 99,
                tty: "ttys001",
                startedAt: 1_700_000_000_000,
                cpuTime: "0:00.01",
                args: "codex",
                kind: "tui",
                account: "work",
                proxyTarget: null,
                cwd: "/repo/fixture",
            };
            const scan = spyOn(processScan, "listActiveAgentProcesses").mockResolvedValue([
                { ...tui, pid: 100, args: "codex app-server", kind: "app-server" },
                tui,
            ]);
            const refs = spyOn(journalRefs, "loadAllSessionCmuxRefs").mockReturnValue(
                new Map([
                    [
                        sessionId,
                        {
                            sessionId,
                            provider: "codex",
                            surfaceId: "surface-uuid",
                            workspaceId: null,
                            workspaceRef: null,
                            paneRef: null,
                            surfaceRef: null,
                            windowRef: null,
                            tmuxPane: null,
                            cwd: tui.cwd,
                            at: Date.now(),
                        },
                    ],
                ])
            );
            const options = {
                alias: "codex" as const,
                classify: classifyCodexArgs,
                helperKinds: CODEX_HELPER_KINDS,
                resumeIdFromArgs: codexResumeIdFromArgs,
                activeSessions: async () => [{ sessionId, cwd: tui.cwd }],
            };

            try {
                const all = await listActiveAgentSessions(options, {
                    runner: async () =>
                        SafeJSON.stringify({
                            windows:
                                source === "hook-tty"
                                    ? [
                                          {
                                              workspaces: [
                                                  {
                                                      panes: [
                                                          {
                                                              surfaces: [
                                                                  {
                                                                      id: "surface-uuid",
                                                                      ref: "surface:1",
                                                                      tty: tui.tty,
                                                                  },
                                                              ],
                                                          },
                                                      ],
                                                  },
                                              ],
                                          },
                                      ]
                                    : [],
                        }),
                });
                expect(withoutHelpers(options, all)).toEqual([
                    expect.objectContaining({
                        pid: 101,
                        sessionId,
                        sessionSource: source,
                        sessionInstances: 1,
                    }),
                ]);
                expect(all.find((entry) => entry.kind === "app-server")).toMatchObject({
                    sessionId: null,
                    sessionSource: "none",
                });
            } finally {
                refs.mockRestore();
                scan.mockRestore();
            }
        }
    );
});

describe("bounded adapter catalogs cannot prove cwd uniqueness", () => {
    const visibleId = "11111111-1111-4111-8111-111111111111";
    const hiddenId = "22222222-2222-4222-8222-222222222222";
    const cwd = "/repo/shared";

    for (const mode of ["list", "listCached"] as const) {
        test.each([
            { name: "truncated", truncated: true, resume: false, expectedSource: "none" },
            { name: "complete", truncated: false, resume: false, expectedSource: "cwd-unique" },
            { name: "truncated with explicit resume", truncated: true, resume: true, expectedSource: "resume-arg" },
        ])(
            `${mode}: $name catalog resolves only with sufficient evidence`,
            async ({ truncated, resume, expectedSource }) => {
                const now = Date.now();
                const visible: AgentSession = {
                    kind: "codex",
                    sessionId: visibleId,
                    cwd,
                    title: "Visible session",
                    mtime: new Date(now),
                    filePath: "/fixture/visible.jsonl",
                };
                const catalog: AgentSession[] = truncated
                    ? [
                          visible,
                          ...Array.from({ length: 499 }, (_, index) => ({
                              ...visible,
                              sessionId: `filler-${index}`,
                              cwd: `/repo/other-${index}`,
                          })),
                          {
                              ...visible,
                              sessionId: hiddenId,
                              title: "Hidden session",
                              filePath: "/fixture/hidden.jsonl",
                          },
                      ]
                    : [visible];
                const query = mock(async (filters: AgentSearchFilters) => catalog.slice(0, filters.limit));
                const adapter = { list: query, ...(mode === "listCached" ? { listCached: query } : {}) };
                const scan = spyOn(processScan, "listActiveAgentProcesses").mockResolvedValue([
                    {
                        pid: 101,
                        ppid: 99,
                        tty: "ttys001",
                        startedAt: now,
                        cpuTime: "0:00.01",
                        args: resume ? `codex resume ${visibleId}` : "codex",
                        kind: "tui",
                        account: "work",
                        proxyTarget: null,
                        cwd,
                    },
                ]);
                const refs = spyOn(journalRefs, "loadAllSessionCmuxRefs").mockReturnValue(new Map());

                try {
                    const sessions = await listActiveAgentSessions(
                        {
                            alias: "codex",
                            classify: classifyCodexArgs,
                            resumeIdFromArgs: codexResumeIdFromArgs,
                            activeSessions: () => sessionsFromAdapter(adapter, now),
                        },
                        { runner: async () => '{"windows":[]}' }
                    );
                    expect(query).toHaveBeenCalledTimes(1);
                    expect(query.mock.calls[0]?.[0].limit).toBe(500);

                    if (truncated) {
                        expect(catalog.filter((session) => session.cwd === cwd)).toHaveLength(2);
                        expect(catalog.slice(0, 500).filter((session) => session.cwd === cwd)).toHaveLength(1);
                        expect(catalog[500]?.sessionId).toBe(hiddenId);
                    }

                    const resolved = !truncated || resume;
                    expect(sessions).toEqual([
                        expect.objectContaining({
                            sessionId: resolved ? visibleId : null,
                            sessionSource: expectedSource,
                            sessionTitle: resolved ? "Visible session" : null,
                            lastActivityAt: resolved ? now : null,
                        }),
                    ]);
                } finally {
                    refs.mockRestore();
                    scan.mockRestore();
                }
            }
        );
    }
});
