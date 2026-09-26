import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TranscriptTool, TranscriptTurn } from "@genesiscz/utils/ai/transcripts";
import { SafeJSON } from "@genesiscz/utils/json";
import { composeHandoff, HandoffRangeError, selectRange } from "./handoff";
import { catalogPricer, postSessionHandoff } from "./index";
import { codexModelOf, scanClaudeNative, toolInputKeys } from "./native";
import {
    defaultStuckThresholds,
    normalizeStuckThresholds,
    parseThresholdFlag,
    readStuckThresholds,
    stuckVerdict,
    updateStuckThresholds,
} from "./stuck";
import { buildToolStats, buildTurnCosts, type CallPricer } from "./timeline";

const T0 = Date.parse("2026-01-10T10:00:00.000Z");

function iso(offsetSeconds: number): string {
    return new Date(T0 + offsetSeconds * 1000).toISOString();
}

function tool(id: string, name: string, preview: string, extra: Partial<TranscriptTool> = {}): TranscriptTool {
    return { id, name, inputPreview: preview, result: "ok", isError: false, ...extra };
}

function user(id: string, text: string, at: number): TranscriptTurn {
    return { id, role: "user", at: iso(at), text, tools: [] };
}

function assistant(id: string, at: number, extra: Partial<TranscriptTurn> = {}): TranscriptTurn {
    return { id, role: "assistant", at: iso(at), text: "", tools: [], ...extra };
}

function line(record: Record<string, unknown>): string {
    return SafeJSON.stringify(record, { strict: true }) ?? "";
}

/** A tiny Claude session file: two prompts, a split message, a thinking-only call, a sub-agent line. */
function claudeFile(): string {
    return [
        line({
            type: "user",
            uuid: "u1",
            timestamp: iso(0),
            cwd: "/work/app",
            gitBranch: "feat/a",
            message: { role: "user", content: "first" },
        }),
        line({
            type: "assistant",
            uuid: "a1",
            timestamp: iso(5),
            message: {
                id: "m1",
                model: "claude-sonnet-4-5-20250929",
                usage: {
                    input_tokens: 100_000,
                    output_tokens: 10_000,
                    cache_read_input_tokens: 0,
                    cache_creation_input_tokens: 0,
                },
                content: [{ type: "text", text: "reading" }],
            },
        }),
        // Same message id on its next content block: one call, not two.
        line({
            type: "assistant",
            uuid: "a1b",
            timestamp: iso(6),
            message: {
                id: "m1",
                model: "claude-sonnet-4-5-20250929",
                usage: { input_tokens: 100_000, output_tokens: 10_000 },
                content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }],
            },
        }),
        line({
            type: "user",
            uuid: "r1",
            timestamp: iso(16),
            message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "a.txt" }] },
        }),
        line({
            type: "user",
            uuid: "side",
            isSidechain: true,
            timestamp: iso(17),
            message: { role: "user", content: "sub-agent" },
        }),
        line({
            type: "user",
            uuid: "u2",
            timestamp: iso(60),
            gitBranch: "feat/b",
            message: { role: "user", content: "second" },
        }),
        // Thinking only: no transcript turn, but a real call that belongs to prompt u2.
        line({
            type: "assistant",
            uuid: "a2",
            timestamp: iso(62),
            message: {
                id: "m2",
                model: "claude-sonnet-4-5-20250929",
                usage: {
                    input_tokens: 10,
                    output_tokens: 5,
                    cache_read_input_tokens: 50_000,
                    cache_creation_input_tokens: 2_000,
                },
                content: [{ type: "thinking", thinking: "hmm" }],
            },
        }),
        line({ type: "summary", summary: "not a conversation line" }),
    ].join("\n");
}

/** The transcript turns `tools ai sessions tail` builds from that file. */
function claudeTurns(): TranscriptTurn[] {
    return [
        user("u1", "first", 0),
        assistant("a1", 5, { text: "reading" }),
        assistant("a1b", 6, { tools: [tool("t1", "Bash", "ls", { result: "a.txt" })] }),
        user("u2", "second", 60),
    ];
}

describe("scanClaudeNative", () => {
    test("counts a split message once, skips sub-agent lines and records exact tool timing", () => {
        const scan = scanClaudeNative(claudeFile());

        expect(scan.calls.map((call) => call.messageId)).toEqual(["m1", "m2"]);
        expect(scan.calls[0]?.input).toBe(100_000);
        expect(scan.calls[1]?.cacheWrite).toBe(2_000);
        expect(scan.ordinals.has("side")).toBe(false);
        expect(scan.ordinals.get("u2")).toBe(5);
        expect(scan.toolTimings.get("t1")).toEqual({ startedAt: iso(6), endedAt: iso(16) });
        expect(scan.cwd).toBe("/work/app");
        expect(scan.branch).toBe("feat/b");
    });

    test("full tool inputs tell two edits of one file apart", () => {
        const text = [
            line({
                type: "assistant",
                message: {
                    content: [
                        {
                            type: "tool_use",
                            id: "e1",
                            name: "Edit",
                            input: { file_path: "/a.ts", old_string: "x", new_string: "y" },
                        },
                    ],
                },
            }),
            line({
                type: "assistant",
                message: {
                    content: [
                        {
                            type: "tool_use",
                            id: "e2",
                            name: "Edit",
                            input: { file_path: "/a.ts", old_string: "p", new_string: "q" },
                        },
                    ],
                },
            }),
        ].join("\n");
        const keys = toolInputKeys(text, "claude");

        expect(keys.get("e1")).not.toBe(keys.get("e2"));
        expect(codexModelOf(line({ type: "turn_context", payload: { model: "gpt-5.5" } }))).toBe("gpt-5.5");
    });
});

describe("buildTurnCosts", () => {
    const flatPricer: CallPricer = (call) => (call.model ? (call.input + call.output) / 1_000_000 : null);

    test("assigns every native call to its prompt, the thinking-only call included, and ranks by cost", () => {
        const result = buildTurnCosts({
            turns: claudeTurns(),
            native: scanClaudeNative(claudeFile()),
            price: flatPricer,
        });

        expect(result.turns.map((turn) => [turn.number, turn.turnId, turn.modelCalls])).toEqual([
            [1, "u1", 1],
            [4, "u2", 1],
        ]);
        expect(result.turns[1]?.cacheWriteTokens).toBe(2_000);
        expect(result.turns[0]?.costUsd).toBeCloseTo(0.11);
        expect(result.turns[0]?.rank).toBe(1);
        expect(result.turns[1]?.rank).toBe(2);
        expect(result.turns[0]?.toolCount).toBe(1);
        expect(result.turns[0]?.models).toEqual(["sonnet"]);
        expect(result.priced).toBe(true);
        expect(result.totals.modelCalls).toBe(2);
    });

    test("an unpriced call leaves the turn without a cost and ranks by billable tokens instead", () => {
        const turns = [
            user("u1", "one", 0),
            assistant("a1", 1, { usage: { inputTokens: 10, outputTokens: 10, cacheReadTokens: 900_000 } }),
            user("u2", "two", 10),
            assistant("a2", 11, { usage: { inputTokens: 5_000, outputTokens: 100 } }),
        ];
        const result = buildTurnCosts({ turns, price: () => null });

        expect(result.priced).toBe(false);
        expect(result.turns[0]?.costUsd).toBeNull();
        expect(result.turns[0]?.cacheReadTokens).toBe(900_000);
        // Cache reads do not win the ranking on their own.
        expect(result.turns[1]?.rank).toBe(1);
        expect(result.turns[0]?.rank).toBe(2);
    });

    test("envelope usage is priced with the session's model when calls name none", () => {
        const turns = [
            user("u1", "one", 0),
            assistant("a1", 1, { usage: { inputTokens: 1_000_000, outputTokens: 0 } }),
        ];
        const result = buildTurnCosts({ turns, defaultModel: "gpt-x", price: flatPricer });

        expect(result.turns[0]?.costUsd).toBeCloseTo(1);
        expect(result.turns[0]?.models).toEqual(["gpt-x"]);
    });

    test("the catalog pricer prices a listed model at list rates and refuses an unknown one", () => {
        const price = catalogPricer();
        const call = { input: 100_000, output: 10_000, cacheRead: 0, cacheWrite: 0, reasoning: 0, at: iso(0) };

        expect(price({ ...call, model: "claude-sonnet-4-5-20250929" })).toBeCloseTo(0.45);
        expect(price({ ...call, model: "invented-model-9" })).toBeNull();
        expect(price({ ...call, model: null })).toBeNull();
    });
});

describe("buildToolStats", () => {
    test("uses exact native timing when known, the gap to the next entry otherwise, and skips a pending call", () => {
        const turns = [
            ...claudeTurns(),
            assistant("a3", 70, {
                tools: [
                    tool("t2", "Bash", "false", { isError: true, exitCode: 1 }),
                    tool("t3", "Read", "/work/app/a.ts"),
                ],
            }),
            assistant("a4", 100, { tools: [tool("t4", "Bash", "sleep 999", { result: null })] }),
        ];
        const stats = buildToolStats({ turns, native: scanClaudeNative(claudeFile()) });
        const bash = stats.find((stat) => stat.name === "Bash");

        expect(stats[0]?.name).toBe("Bash");
        expect(bash?.count).toBe(3);
        expect(bash?.failures).toBe(1);
        expect(bash?.failureRate).toBeCloseTo(1 / 3);
        // t1 exact 10 s, t2 gap 30 s, t4 pending and not measured.
        expect(bash?.totalMs).toBe(40_000);
        expect(bash?.slowestMs).toBe(30_000);
        expect(bash?.slowestToolId).toBe("t2");
        expect(bash?.slowestTurnIndex).toBe(4);
        expect(bash?.timing).toBe("upper-bound");
    });
});

describe("stuckVerdict", () => {
    const thresholds = defaultStuckThresholds();

    test("flags a call waiting past the threshold, and not before it", () => {
        const turns = [
            user("u1", "go", 0),
            assistant("a1", 10, { tools: [tool("t1", "Bash", "make test", { result: null })] }),
        ];
        const late = stuckVerdict({ turns, now: T0 + 10_000 + 11 * 60_000, thresholds });
        const early = stuckVerdict({ turns, now: T0 + 10_000 + 9 * 60_000, thresholds });

        expect(late?.kind).toBe("long-tool");
        expect(late?.tool).toBe("Bash");
        expect(late?.argument).toBe("make test");
        expect(late?.turnIndex).toBe(1);
        expect(early).toBeNull();
    });

    test("a sub-agent call, a dead session and an ended transcript are not stuck", () => {
        const agent = [
            user("u1", "go", 0),
            assistant("a1", 0, { tools: [tool("t1", "Agent", "research", { result: null })] }),
        ];
        const bash = [user("u1", "go", 0), assistant("a1", 0, { tools: [tool("t1", "Bash", "x", { result: null })] })];

        expect(stuckVerdict({ turns: agent, now: T0 + 30 * 60_000, thresholds })).toBeNull();
        expect(stuckVerdict({ turns: bash, now: T0 + 7 * 3_600_000, thresholds })).toBeNull();
        expect(stuckVerdict({ turns: bash, now: T0 + 30 * 60_000, thresholds, terminated: true })).toBeNull();
    });

    test("flags the same call repeated at the end, counting its failures", () => {
        const turns: TranscriptTurn[] = [user("u1", "fix", 0)];

        for (let i = 0; i < 6; i += 1) {
            turns.push(
                assistant(`a${i}`, 10 + i, { tools: [tool(`t${i}`, "Bash", "bun run  build", { isError: i > 0 })] })
            );
        }

        const verdict = stuckVerdict({ turns, now: T0 + 60_000, thresholds });

        expect(verdict?.kind).toBe("repeat-loop");
        expect(verdict?.count).toBe(6);
        expect(verdict?.failures).toBe(5);
        expect(verdict?.toolId).toBe("t0");
        expect(verdict?.detail).toContain("6 times in a row, 5 failed");
    });

    test("different full inputs, an ignored tool, an old loop and a new prompt all break a loop", () => {
        const edits: TranscriptTurn[] = [user("u1", "edit", 0)];
        const keys = new Map<string, string>();

        for (let i = 0; i < 5; i += 1) {
            edits.push(assistant(`a${i}`, 10 + i, { tools: [tool(`e${i}`, "Edit", "/a.ts")] }));
            keys.set(`e${i}`, `{"old":"${i}"}`);
        }

        const polls = edits.map((turn) => ({
            ...turn,
            tools: turn.tools.map((call) => ({ ...call, name: "BashOutput", inputPreview: "shell-1" })),
        }));
        const reset = [...edits.slice(0, 3), user("u2", "again", 13), ...edits.slice(3)];

        expect(stuckVerdict({ turns: edits, now: T0 + 60_000, thresholds })?.kind).toBe("repeat-loop");
        expect(stuckVerdict({ turns: edits, now: T0 + 60_000, thresholds, inputKeys: keys })).toBeNull();
        expect(stuckVerdict({ turns: polls, now: T0 + 60_000, thresholds })).toBeNull();
        expect(stuckVerdict({ turns: edits, now: T0 + 3_600_000, thresholds })).toBeNull();
        expect(stuckVerdict({ turns: reset, now: T0 + 60_000, thresholds })).toBeNull();
    });

    test("a waiting call wins over the loop it ends", () => {
        const turns: TranscriptTurn[] = [user("u1", "go", 0)];

        for (let i = 0; i < 5; i += 1) {
            turns.push(
                assistant(`a${i}`, i, { tools: [tool(`t${i}`, "Bash", "curl x", { result: i === 4 ? null : "ok" })] })
            );
        }

        expect(stuckVerdict({ turns, now: T0 + 15 * 60_000, thresholds })?.kind).toBe("long-tool");
    });
});

describe("stuck thresholds", () => {
    test("a hand-edited file is clamped and a wrong type falls back to the default", () => {
        const normalized = normalizeStuckThresholds({ toolMinutes: 0, repeats: "many", ignoreLongTools: ["Agent", 3] });

        expect(normalized.toolMinutes).toBe(1);
        expect(normalized.repeats).toBe(5);
        expect(normalized.ignoreLongTools).toEqual(["Agent"]);
    });

    test("a CLI flag outside the limits is an error, never clamped", () => {
        expect(parseThresholdFlag("repeats", "--repeats", "3")).toBe(3);
        expect(() => parseThresholdFlag("repeats", "--repeats", "1")).toThrow("from 2 to 100, got 1");
        expect(() => parseThresholdFlag("toolMinutes", "--tool-minutes", "2.5")).toThrow();
    });

    test("an update keeps the other fields and reset starts from the defaults", async () => {
        const path = join(mkdtempSync(join(tmpdir(), "hub-stuck-")), "stuck.json");
        await updateStuckThresholds({ toolMinutes: 15 }, path);
        const saved = await updateStuckThresholds({ repeats: 8 }, path);

        expect(saved.toolMinutes).toBe(15);
        expect(saved.repeats).toBe(8);
        expect(readStuckThresholds(path).repeats).toBe(8);
        expect(SafeJSON.parse(readFileSync(path, "utf8"))).toMatchObject({ toolMinutes: 15 });
        expect((await updateStuckThresholds({ reset: true }, path)).toolMinutes).toBe(10);
    });
});

describe("composeHandoff", () => {
    function session(): TranscriptTurn[] {
        return [
            user("p1", "Build the export feature\nwith CSV support", 0),
            assistant("r1", 5, {
                text: "Done with the first part. The parser works.",
                tools: [
                    tool("w1", "Write", "/work/app/src/export.ts"),
                    tool("b1", "Bash", 'git commit -m "export"', {
                        result: "[feat/export 1a2b3c4d] add export\n 1 file changed",
                    }),
                ],
            }),
            user("p2", "/compact", 30),
            user("p3", "Now add the tests", 60),
            assistant("r3", 65, {
                text: "Tests are red.\n- [ ] fix the date column\nTODO: check the empty case",
                tools: [
                    tool("e1", "Edit", "/work/app/src/export.ts"),
                    tool("rd", "Read", "/work/app/README.md"),
                    tool("b2", "Bash", "bun run test", { isError: true, exitCode: 1, result: "\n1 fail\nmore" }),
                    tool("b3", "Bash", "bun run lint", { isError: true, exitCode: 2, result: "lint error" }),
                    tool("b4", "Bash", "bun run lint", { result: "clean" }),
                    tool("b5", "Bash", "bun run e2e", { result: null }),
                ],
            }),
        ];
    }

    const meta = {
        sessionId: "sess-1234-abcd",
        provider: "claude" as const,
        cwd: "/work/app",
        resumeCommand: "claude --resume sess-1234-abcd",
    };

    test("the last N prompts pick their turns up to the end", () => {
        expect(selectRange(session(), { last: 2 })).toEqual({ start: 2, end: 5, prompts: [2, 3] });
        expect(selectRange(session(), { from: 1, to: 1 })).toEqual({ start: 0, end: 2, prompts: [0] });
        expect(() => selectRange(session(), { from: 5, to: 9 })).toThrow(HandoffRangeError);
        expect(() => selectRange(session(), { last: 0 })).toThrow(HandoffRangeError);
    });

    test("the brief names the goal, the work, the files, the commits and what is still open", () => {
        const draft = composeHandoff({ turns: session(), meta, range: { last: 2 } });

        expect(draft.title).toBe("Continue: Build the export feature");
        // A range opening with /compact still states the task.
        expect(draft.goal).toBe("Now add the tests");
        expect([draft.fromNumber, draft.toNumber, draft.promptCount]).toEqual([3, 4, 2]);
        expect(draft.changedFiles).toEqual([{ path: "/work/app/src/export.ts", edits: 1, writes: 0, reads: 0 }]);
        expect(draft.readFiles).toEqual(["/work/app/README.md"]);
        expect(draft.openItems).toEqual([
            "Bash was still running: `bun run e2e`",
            "Bash failed (exit 1): `bun run test`: 1 fail",
            "From the last reply: [ ] fix the date column",
            "From the last reply: TODO: check the empty case",
        ]);
        expect(draft.markdown).toContain("- Resume: `cd '/work/app' && claude --resume sess-1234-abcd`");
        expect(draft.markdown).toContain("- **#4** Now add the tests");
        expect(draft.markdown).toContain("Ran 4 commands · Read 1 file · Changed 1 file · 2 failed");
    });

    test("a teammate message or task notification is never the goal: the user's last own prompt is", () => {
        const turns = [
            ...session(),
            user(
                "p4",
                'Another Claude session sent a message:\n<teammate-message teammate_id="peer">done</teammate-message>',
                90
            ),
            user("p5", "[SYSTEM NOTIFICATION - NOT USER INPUT]\n<task-notification>x</task-notification>", 95),
        ];
        const draft = composeHandoff({ turns, meta, range: { last: 2 } });

        expect(draft.goal).toBe("Now add the tests");
    });

    test("commits and an unanswered last prompt are reported", () => {
        const turns = [...session().slice(0, 2), user("p9", "and deploy it", 90)];
        const draft = composeHandoff({ turns, meta, range: { from: 1, to: 3 } });

        expect(draft.commits).toEqual([{ sha: "1a2b3c4d", branch: "feat/export", subject: "add export" }]);
        expect(draft.markdown).toContain("`1a2b3c4d` add export (feat/export)");
        expect(draft.openItems[0]).toBe('Answer the last prompt, which has no reply yet: "and deploy it"');
    });
});
describe("postSessionHandoff", () => {
    function draft(openItems: string[]) {
        return {
            ...composeHandoff({
                turns: [user("p1", "Ship the report", 0), assistant("r1", 5, { text: "Started." })],
                meta: { sessionId: "sess-9", provider: "claude" as const },
                range: { last: 1 },
            }),
            openItems,
            sessionId: "sess-9",
            provider: "claude",
        };
    }

    function store() {
        const dir = mkdtempSync(join(tmpdir(), "hub-handoff-"));
        return { base: join(dir, "log"), dbPath: join(dir, "qa.db") };
    }

    test("the hub posts as the human owner in the session's folder, one task per open item", () => {
        const response = postSessionHandoff(draft(["Fix the date column", "Answer the last prompt"]), {
            owner: true,
            cwd: "/work/app",
            branch: "feat/report",
            store: store(),
        });

        expect(response.handoff.title).toBe("Continue: Ship the report");
        expect(response.handoff.tasks.map((task) => task.text)).toEqual([
            "Fix the date column",
            "Answer the last prompt",
        ]);
        expect(response.handoff.description).toContain("## Open items");
        expect(response.handoff.refs).toEqual(["sess-9"]);
        expect(response.handoff.postedByContext.agent).toBe("human");
        expect(response.handoff.postedByContext.cwd).toBe("/work/app");
    });

    test("a draft with nothing open still posts one task to continue", () => {
        const response = postSessionHandoff(draft([]), { owner: true, store: store() });

        expect(response.handoff.tasks).toHaveLength(1);
        expect(response.handoff.tasks[0]?.text).toContain("Continue");
    });
});
