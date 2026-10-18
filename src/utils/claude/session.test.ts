import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import type { ClaudeSession as Session } from "./session";

// PROJECTS_DIR is ~/.claude/projects, fixed at import time. Point it at a temp folder before session.ts loads.
const projectsDir = mkdtempSync(join(tmpdir(), "gt-claude-session-"));
const realProjects = await import("./projects");
const realEncodedProjectDir = realProjects.encodedProjectDir;
// With no argument the real encodedProjectDir() runs `git rev-parse` in the current directory; a fixed one needs no process.
mock.module("./projects", () => ({
    ...realProjects,
    PROJECTS_DIR: projectsDir,
    encodedProjectDir: (cwd?: string) => realEncodedProjectDir(cwd ?? "/work/current"),
}));
const { ClaudeSession } = await import("./session");

type Row = Record<string, unknown>;

const SID = "9f1c2a40-0000-4000-8000-000000000001";
const CWD = "/work/acme-widgets";
const FILE = `${CWD}/src/invoice.ts`;

function at(minute: number): string {
    return new Date(Date.UTC(2026, 2, 1, 10, minute)).toISOString();
}

function envelope(minute: number, extra: Row = {}): Row {
    return {
        uuid: `uuid-${minute}`,
        parentUuid: null,
        sessionId: SID,
        timestamp: at(minute),
        userType: "external",
        ...extra,
    };
}

function userRow(minute: number, content: unknown, extra: Row = {}): Row {
    return { type: "user", ...envelope(minute), message: { role: "user", content }, ...extra };
}

function assistantContent(
    content: unknown[],
    opts: { model?: string; usage?: Row | null; stop?: string | null } = {}
): Row {
    return {
        role: "assistant",
        id: "msg-fixture",
        type: "message",
        model: opts.model ?? "claude-test-1",
        stop_reason: opts.stop ?? null,
        stop_sequence: null,
        usage: opts.usage === null ? undefined : (opts.usage ?? { input_tokens: 0, output_tokens: 0 }),
        content,
    };
}

function assistantRow(minute: number, content: unknown[], opts: { model?: string; usage?: Row | null } = {}): Row {
    return { type: "assistant", ...envelope(minute), message: assistantContent(content, opts) };
}

function toolUse(id: string, name: string, input: Row): Row {
    return { type: "tool_use", id, name, input };
}

function toolResult(id: string, content: unknown, isError?: boolean): Row {
    return { type: "tool_result", tool_use_id: id, content, ...(isError ? { is_error: true } : {}) };
}

function text(value: string): Row {
    return { type: "text", text: value };
}

const IMAGE: Row = { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } };
const TOOL_REF: Row = { type: "tool_reference", tool_name: "Grep" };

function writeJsonl(path: string, lines: Array<Row | string>): string {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(
        path,
        `${lines.map((line) => (typeof line === "string" ? line : SafeJSON.stringify(line))).join("\n")}\n`
    );
    return path;
}

const mainRows: Array<Row | string> = [
    { type: "custom-title", customTitle: "Fix invoice rounding", sessionId: SID },
    userRow(0, "Please fix the invoice rounding", { cwd: CWD, gitBranch: "feat/invoices" }),
    assistantRow(
        1,
        [
            { type: "thinking", thinking: "Plan: read the module first" },
            text("I will read the invoice module."),
            toolUse("tu1", "Read", { file_path: FILE }),
            IMAGE,
            TOOL_REF,
        ],
        {
            usage: {
                input_tokens: 100,
                output_tokens: 50,
                cache_read_input_tokens: 20,
                server_tool_use: { web_search_requests: 1, web_fetch_requests: 2 },
            },
        }
    ),
    userRow(2, [toolResult("tu1", "export const round = (n: number) => n;")]),
    "{ this line is not json",
    assistantRow(
        3,
        [
            text("Editing now."),
            toolUse("tu2", "Edit", { file_path: FILE, old_string: "n", new_string: "Math.round(n)" }),
            toolUse("tu3", "Bash", { command: "git commit -m fix" }),
        ],
        {
            model: "claude-test-2",
            usage: { input_tokens: 200, output_tokens: 80, server_tool_use: null },
        }
    ),
    userRow(4, [
        toolResult("tu2", "File updated"),
        toolResult("tu3", "[main abc1234] fix invoice rounding\n create mode 100644 src/round.ts\n1111111 repeated"),
    ]),
    {
        type: "progress",
        ...envelope(5),
        toolUseID: "t1",
        parentToolUseID: "t0",
        data: {
            type: "bash_progress",
            output: "committed 0123abcd to the branch",
            fullOutput: "",
            elapsedTimeSeconds: 1,
            totalLines: 1,
        },
    },
    {
        type: "progress",
        ...envelope(5),
        toolUseID: "t1",
        parentToolUseID: "t0",
        data: {
            type: "bash_progress",
            output: "unrelated output deadbee1",
            fullOutput: "",
            elapsedTimeSeconds: 1,
            totalLines: 1,
        },
    },
    {
        type: "progress",
        ...envelope(6),
        toolUseID: "t2",
        parentToolUseID: "t0",
        data: {
            type: "agent_progress",
            agentId: "agent-1",
            message: { type: "user", message: { role: "user", content: "Find rounding helpers" }, timestamp: at(6) },
        },
    },
    {
        type: "progress",
        ...envelope(7),
        toolUseID: "t2",
        parentToolUseID: "t0",
        data: {
            type: "agent_progress",
            agentId: "agent-1",
            message: {
                type: "assistant",
                message: assistantContent(
                    [
                        { type: "thinking", thinking: "sub plan" },
                        text("Searching."),
                        toolUse("tu4", "Grep", { pattern: "round", path: `${CWD}/src` }),
                    ],
                    {
                        model: "claude-test-sub",
                        usage: {
                            input_tokens: 10,
                            output_tokens: 5,
                            cache_read_input_tokens: 2,
                            server_tool_use: { web_search_requests: 3, web_fetch_requests: 0 },
                        },
                    }
                ),
            },
        },
    },
    {
        type: "progress",
        ...envelope(8),
        toolUseID: "t3",
        parentToolUseID: "t0",
        data: { type: "agent_progress", agentId: "agent-1" },
    },
    { type: "system", ...envelope(9), subtype: "turn_duration" },
    { type: "summary", summary: "First summary", leafUuid: "leaf-1" },
    { type: "pr-link", url: "https://github.com/acme/widgets/pull/12", sessionId: SID, timestamp: at(10) },
    { type: "summary", summary: "Second summary", leafUuid: "leaf-2" },
    userRow(11, [text("Thanks, ship it"), IMAGE, TOOL_REF]),
    assistantRow(12, [text("Done: the PR is up.")], { usage: { input_tokens: 5, output_tokens: 7 } }),
];

let mainPath: string;

beforeAll(() => {
    mainPath = writeJsonl(join(projectsDir, "-Users-alice-acme-widgets", `${SID}.jsonl`), mainRows);
});

afterAll(() => {
    rmSync(projectsDir, { recursive: true, force: true });
});

describe("ClaudeSession.fromFile", () => {
    it("skips unparseable lines and keeps the other 17 records in order", async () => {
        const session = await ClaudeSession.fromFile(mainPath);

        expect(session.messages).toHaveLength(17);
        expect(session.messages.map((m) => m.type).slice(0, 4)).toEqual(["custom-title", "user", "assistant", "user"]);
    });

    it("turns agent_progress records into subagent messages and leaves other progress alone", async () => {
        const session = await ClaudeSession.fromFile(mainPath);

        expect(session.subagentMessages.map((m) => m.role)).toEqual(["user", "assistant"]);
        expect(session.subagentMessages[1].agentId).toBe("agent-1");
        expect(session.subagentMessages[1].timestamp).toBe(at(7));
        // two bash_progress records plus the agent_progress that has no inner message
        expect(session.progressMessages).toHaveLength(3);
    });

    it("returns an empty session for a file that does not exist", async () => {
        const session = await ClaudeSession.fromFile(join(projectsDir, "missing.jsonl"));

        expect(session.messages).toEqual([]);
        expect(session.sessionId).toBeNull();
        expect(session.startDate).toBeNull();
        expect(session.endDate).toBeNull();
        expect(session.duration).toBe(0);
    });
});

describe("ClaudeSession metadata", () => {
    it("reads identity fields from the first record that carries them", async () => {
        const session = await ClaudeSession.fromFile(mainPath);

        expect(session.sessionId).toBe(SID);
        expect(session.title).toBe("Fix invoice rounding");
        expect(session.gitBranch).toBe("feat/invoices");
        expect(session.cwd).toBe(CWD);
        expect(session.filePath).toBe(mainPath);
        expect(session.isSubagent).toBe(false);
    });

    it("uses the last summary because Claude rewrites it", async () => {
        const session = await ClaudeSession.fromFile(mainPath);

        expect(session.summary).toBe("Second summary");
    });

    it("derives the project name from the encoded folder under the projects dir", async () => {
        const session = await ClaudeSession.fromFile(mainPath);

        expect(session.project).toBe("widgets");
    });

    it("has no project when the file is not inside the projects dir", async () => {
        const elsewhere = mkdtempSync(join(tmpdir(), "gt-claude-elsewhere-"));
        const session = await ClaudeSession.fromFile(writeJsonl(join(elsewhere, "stray.jsonl"), []));

        expect(session.project).toBeNull();
        rmSync(elsewhere, { recursive: true, force: true });
    });

    it("reports start, end and duration from the first and last timestamps", async () => {
        const session = await ClaudeSession.fromFile(mainPath);

        expect(session.startDate?.toISOString()).toBe(at(0));
        expect(session.endDate?.toISOString()).toBe(at(12));
        expect(session.duration).toBe(12 * 60_000);
    });

    it("has no title, summary, branch or cwd when no record carries one", async () => {
        const path = writeJsonl(join(projectsDir, "-bare", "bare.jsonl"), [
            { type: "queue-operation", operation: "enqueue" },
        ]);
        const session = await ClaudeSession.fromFile(path);

        expect(session.title).toBeNull();
        expect(session.summary).toBeNull();
        expect(session.gitBranch).toBeNull();
        expect(session.cwd).toBeNull();
        expect(session.sessionId).toBeNull();
    });

    it("flags files named agent-* or under subagents/ as subagent sessions", async () => {
        const byName = await ClaudeSession.fromFile(writeJsonl(join(projectsDir, "-flags", "agent-abc.jsonl"), []));
        const byFolder = await ClaudeSession.fromFile(
            writeJsonl(join(projectsDir, "-flags", "parent", "subagents", "worker.jsonl"), [])
        );

        expect(byName.isSubagent).toBe(true);
        expect(byFolder.isSubagent).toBe(true);
    });
});

describe("ClaudeSession message access", () => {
    it("splits records by type", async () => {
        const session = await ClaudeSession.fromFile(mainPath);

        expect(session.userMessages).toHaveLength(4);
        expect(session.assistantMessages).toHaveLength(3);
        expect(session.systemMessages).toHaveLength(1);
        expect(session.prLinkMessages.map((m) => m.url)).toEqual(["https://github.com/acme/widgets/pull/12"]);
    });
});

describe("ClaudeSession content extraction", () => {
    it("extracts the plain transcript with tool names and attachments", async () => {
        const session = await ClaudeSession.fromFile(mainPath);
        const lines = session.extractText().split("\n");

        expect(lines).toContain("Fix invoice rounding");
        expect(lines).toContain("Please fix the invoice rounding");
        expect(lines).toContain("I will read the invoice module.");
        expect(lines).toContain(`[Read] ${FILE}`);
        expect(lines).toContain("[Image: image/png]");
        expect(lines).toContain("[Tool Reference: Grep]");
        expect(lines).toContain("[Bash]");
        expect(lines).toContain("First summary");
        expect(lines).toContain("[PR Link]: https://github.com/acme/widgets/pull/12");
        expect(lines).toContain("Searching.");
        expect(lines).toContain("Find rounding helpers");
        expect(lines).not.toContain("Plan: read the module first");
        expect(lines).not.toContain("[System: turn_duration]");
    });

    it("adds thinking, system records and tool results only when asked", async () => {
        const session = await ClaudeSession.fromFile(mainPath);
        const lines = session
            .extractText({ includeThinking: true, includeSystemMessages: true, includeToolResults: true })
            .split("\n");

        expect(lines).toContain("Plan: read the module first");
        expect(lines).toContain("[System: turn_duration]");
        expect(lines).toContain("[Tool Result]: File updated");
    });

    it("drops tool names when includeToolNames is false", async () => {
        const session = await ClaudeSession.fromFile(mainPath);
        const lines = session.extractText({ includeToolNames: false }).split("\n");

        expect(lines).not.toContain(`[Read] ${FILE}`);
        expect(lines).not.toContain("[Bash]");
    });

    it("cuts the transcript at maxLength", async () => {
        const session = await ClaudeSession.fromFile(mainPath);

        expect(session.extractText({ maxLength: 20 })).toBe("Fix invoice rounding");
    });

    describe("tool results", () => {
        const resultRows: Row[] = [
            userRow(0, [text("Run it"), toolResult("t1", "STRING-RESULT"), toolResult("t2", [text("ARRAY-RESULT")])]),
            {
                type: "subagent",
                ...envelope(1),
                role: "user",
                message: { role: "user", content: [toolResult("t3", "SUBAGENT-RESULT")] },
            },
        ];
        const occurrences = (haystack: string, needle: string) => haystack.split(needle).length - 1;

        async function resultSession(): Promise<Session> {
            return ClaudeSession.fromFile(writeJsonl(join(projectsDir, "-results", "results.jsonl"), resultRows));
        }

        it("leaves tool results out unless includeToolResults is set", async () => {
            const transcript = (await resultSession()).extractText();

            expect(transcript).toBe("Run it");
        });

        it("includes each tool result exactly once when includeToolResults is set", async () => {
            const transcript = (await resultSession()).extractText({ includeToolResults: true });

            expect(occurrences(transcript, "STRING-RESULT")).toBe(1);
            expect(occurrences(transcript, "ARRAY-RESULT")).toBe(1);
            expect(occurrences(transcript, "SUBAGENT-RESULT")).toBe(1);
            expect(transcript).toContain("Run it");
        });
    });

    it("lists tool calls from assistant and subagent messages with file path and timestamp", async () => {
        const session = await ClaudeSession.fromFile(mainPath);
        const calls = session.extractToolCalls();

        expect(calls.map((c) => c.name)).toEqual(["Read", "Edit", "Bash", "Grep"]);
        expect(calls[0]).toEqual({ name: "Read", input: { file_path: FILE }, filePath: FILE, timestamp: at(1) });
        expect(calls[2].filePath).toBeUndefined();
        expect(calls[3].filePath).toBe(`${CWD}/src`);
        expect(calls[3].timestamp).toBe(at(7));
    });

    it("lists each referenced file path once and caches the list", async () => {
        const session = await ClaudeSession.fromFile(mainPath);
        const paths = session.extractFilePaths();

        expect(paths).toEqual([FILE, `${CWD}/src`]);
        expect(session.extractFilePaths()).toBe(paths);
    });

    it("finds commit hashes in tool results and bash progress, skipping repeated digits and non-git output", async () => {
        const session = await ClaudeSession.fromFile(mainPath);

        expect(session.extractCommitHashes()).toEqual(["abc1234", "0123abcd"]);
    });

    it("collects thinking blocks from assistant and subagent messages in order", async () => {
        const session = await ClaudeSession.fromFile(mainPath);

        expect(session.extractThinkingBlocks()).toEqual(["Plan: read the module first", "sub plan"]);
    });

    it("lists pull request links", async () => {
        const session = await ClaudeSession.fromFile(mainPath);

        expect(session.extractPrLinks()).toEqual(["https://github.com/acme/widgets/pull/12"]);
    });
});

describe("ClaudeSession filters", () => {
    it("filterByTool keeps the calling messages and the user messages holding their results", async () => {
        const session = await ClaudeSession.fromFile(mainPath);
        const edits = session.filterByTool("edit");

        expect(edits.messages.map((m) => m.type)).toEqual(["assistant", "user"]);
        expect(edits.extractToolCalls().map((c) => c.name)).toEqual(["Edit", "Bash"]);
        expect(edits.filePath).toBe(mainPath);
    });

    it("filterByTool matches subagent tool calls too", async () => {
        const session = await ClaudeSession.fromFile(mainPath);
        const greps = session.filterByTool("Grep");

        expect(greps.messages.map((m) => m.type)).toEqual(["subagent"]);
    });

    it("filterByTool returns nothing for a tool that was never called", async () => {
        const session = await ClaudeSession.fromFile(mainPath);

        expect(session.filterByTool("WebFetch").messages).toEqual([]);
    });

    it("filterByDateRange returns the same session without bounds", async () => {
        const session = await ClaudeSession.fromFile(mainPath);

        expect(session.filterByDateRange()).toBe(session);
    });

    it("filterByDateRange drops records outside the bounds and records without timestamps", async () => {
        const session = await ClaudeSession.fromFile(mainPath);
        const middle = session.filterByDateRange(new Date(at(3)), new Date(at(4)));
        const since = session.filterByDateRange(new Date(at(11)));
        const until = session.filterByDateRange(undefined, new Date(at(0)));

        expect(middle.messages.map((m) => m.type)).toEqual(["assistant", "user"]);
        expect(since.messages.map((m) => m.type)).toEqual(["user", "assistant"]);
        expect(until.messages.map((m) => m.type)).toEqual(["user"]);
    });

    it("filterByContent matches text case-insensitively across message kinds", async () => {
        const session = await ClaudeSession.fromFile(mainPath);

        expect(session.filterByContent("EDITING NOW").messages.map((m) => m.type)).toEqual(["assistant"]);
        expect(session.filterByContent("rounding helpers").messages.map((m) => m.type)).toEqual(["subagent"]);
        expect(session.filterByContent("searching").messages.map((m) => m.type)).toEqual(["subagent"]);
        expect(session.filterByContent("first summary").messages.map((m) => m.type)).toEqual(["summary"]);
        expect(session.filterByContent("invoice rounding").messages.map((m) => m.type)).toEqual([
            "custom-title",
            "user",
            "user",
        ]);
        expect(session.filterByContent("pull/12").messages.map((m) => m.type)).toEqual(["pr-link"]);
        expect(session.filterByContent("no such phrase anywhere").messages).toEqual([]);
    });

    it("filterByMessageType keeps only the requested types", async () => {
        const session = await ClaudeSession.fromFile(mainPath);

        expect(session.filterByMessageType("summary", "pr-link").messages.map((m) => m.type)).toEqual([
            "summary",
            "pr-link",
            "summary",
        ]);
    });
});

describe("ClaudeSession.stats", () => {
    it("aggregates counts, tokens, models, files and duration across assistant and subagent messages", async () => {
        const stats = (await ClaudeSession.fromFile(mainPath)).stats;

        expect(stats.messageCount).toBe(17);
        expect(stats.userMessageCount).toBe(4);
        expect(stats.assistantMessageCount).toBe(3);
        expect(stats.systemMessageCount).toBe(1);
        expect(stats.subagentMessageCount).toBe(2);
        expect(stats.progressMessageCount).toBe(3);
        expect(stats.prLinkCount).toBe(1);
        expect(stats.toolCallCount).toBe(4);
        expect(stats.toolUsage).toEqual({ Read: 1, Edit: 1, Bash: 1, Grep: 1 });
        expect(stats.tokenUsage).toEqual({ input: 315, output: 142, cached: 22 });
        expect(stats.serverToolUse).toEqual({ webSearchRequests: 4, webFetchRequests: 2 });
        expect(stats.modelsUsed).toEqual(["claude-test-1", "claude-test-2", "claude-test-sub"]);
        expect(stats.filesModified).toEqual([FILE, `${CWD}/src`]);
        expect(stats.duration).toBe(12 * 60_000);
        expect(stats.firstTimestamp?.toISOString()).toBe(at(0));
        expect(stats.lastTimestamp?.toISOString()).toBe(at(12));
    });

    it("is computed once and reused", async () => {
        const session = await ClaudeSession.fromFile(mainPath);

        expect(session.stats).toBe(session.stats);
    });

    it("reports zero duration and null timestamps for a session without timestamps", async () => {
        const path = writeJsonl(join(projectsDir, "-bare", "no-times.jsonl"), [
            { type: "summary", summary: "Only a summary", leafUuid: "l" },
        ]);
        const stats = (await ClaudeSession.fromFile(path)).stats;

        expect(stats.duration).toBe(0);
        expect(stats.firstTimestamp).toBeNull();
        expect(stats.lastTimestamp).toBeNull();
        expect(stats.messageCount).toBe(1);
    });
});

describe("ClaudeSession.toPromptContent formatting", () => {
    const formatRows: Row[] = [
        userRow(0, "  Start here  "),
        assistantRow(1, [
            { type: "thinking", thinking: "Deep thought" },
            text("Hello there"),
            toolUse("t1", "Read", { file_path: "/a/b.ts" }),
            toolUse("t2", "Bash", { command: "ls" }),
            IMAGE,
            TOOL_REF,
        ]),
        userRow(2, [
            text("from blocks"),
            IMAGE,
            TOOL_REF,
            toolResult("t1", "plain result"),
            toolResult("t2", [text("inner text"), IMAGE, TOOL_REF]),
        ]),
        { type: "subagent", ...envelope(3), role: "user", message: { role: "user", content: "Subagent prompt" } },
        { type: "subagent", ...envelope(4), role: "user", message: { role: "user", content: [text("Blocks prompt")] } },
        {
            type: "subagent",
            ...envelope(5),
            role: "assistant",
            message: assistantContent([
                { type: "thinking", thinking: "sub thought" },
                text("sub says"),
                toolUse("t3", "Grep", { pattern: "x", path: "/src" }),
                IMAGE,
                TOOL_REF,
            ]),
        },
        { type: "summary", summary: "Compacted history", leafUuid: "l" },
        { type: "pr-link", url: "https://example.com/pr/1", sessionId: SID, timestamp: at(6) },
        {
            type: "progress",
            ...envelope(7),
            toolUseID: "p",
            parentToolUseID: "q",
            data: { type: "hook_progress", hookEvent: "x", hookName: "y", command: "z" },
        },
        assistantRow(8, [text("Final answer")]),
    ];

    async function formatSession(): Promise<Session> {
        return ClaudeSession.fromFile(writeJsonl(join(projectsDir, "-fmt", "format.jsonl"), formatRows));
    }

    it("lists user messages first, then assistant messages, then the rest, keeping the first and last as bookends", async () => {
        const prepared = (await formatSession()).toPromptContent({ tokenBudget: 10_000, priority: "user-first" });

        expect(prepared.content).toBe(
            [
                "[User]: Start here",
                "[User]: from blocks\n[Image: image/png]\n[Tool Reference: Grep]",
                "[Assistant]: Hello there\n[Tool: Read] /a/b.ts\n[Tool: Bash]\n[Image: image/png]\n[Tool Reference: Grep]",
                "[Subagent User]: Subagent prompt",
                "[Subagent User]: Blocks prompt",
                "[Subagent]: sub says\n[Subagent Tool: Grep] /src\n[Image: image/png]\n[Tool Reference: Grep]",
                "[Summary]: Compacted history",
                "[PR Link]: https://example.com/pr/1",
                "[Assistant]: Final answer",
            ].join("\n\n")
        );
        expect(prepared.truncated).toBe(false);
        expect(prepared.truncationInfo).toBe("All 10 messages included within 10000 token budget.");
        expect(prepared.stats).toEqual({
            userMessages: 2,
            assistantMessages: 2,
            toolCalls: 3,
            filesModified: ["/a/b.ts", "/src"],
        });
    });

    it("includes thinking and tool results and prefixes timestamps when asked", async () => {
        const prepared = (await formatSession()).toPromptContent({
            tokenBudget: 10_000,
            priority: "assistant-first",
            includeThinking: true,
            includeToolResults: true,
            includeTimestamps: true,
        });
        const lines = prepared.content.split("\n");

        expect(lines).toContain(`[${at(0)}] [User]: Start here`);
        expect(lines).toContain(`[${at(1)}] [Thinking]: Deep thought`);
        expect(lines).toContain(`[${at(5)}] [Subagent Thinking]: sub thought`);
        expect(lines).toContain("[Tool Result]: plain result");
        expect(lines).toContain("inner text");
        expect(lines).toContain(`[${at(8)}] [Assistant]: Final answer`);
        expect(lines).toContain("[Summary]: Compacted history");
    });

    it("orders by the requested role when the session is short", async () => {
        const path = writeJsonl(join(projectsDir, "-fmt", "order.jsonl"), [
            userRow(0, "u-first"),
            assistantRow(1, [text("a-one")]),
            userRow(2, "u-two"),
            assistantRow(3, [text("a-two")]),
            userRow(4, "u-last"),
        ]);
        const session = await ClaudeSession.fromFile(path);
        const parts = (priority: "user-first" | "assistant-first") =>
            session.toPromptContent({ tokenBudget: 1000, priority }).content.split("\n\n");

        expect(parts("user-first")).toEqual([
            "[User]: u-first",
            "[User]: u-two",
            "[Assistant]: a-one",
            "[Assistant]: a-two",
            "[User]: u-last",
        ]);
        expect(parts("assistant-first")).toEqual([
            "[User]: u-first",
            "[Assistant]: a-one",
            "[Assistant]: a-two",
            "[User]: u-two",
            "[User]: u-last",
        ]);
    });

    it("stops adding messages when the next one no longer fits the budget", async () => {
        const path = writeJsonl(join(projectsDir, "-fmt", "budget.jsonl"), [
            userRow(0, "first"),
            assistantRow(1, [text("x".repeat(400))]),
            assistantRow(2, [text("y".repeat(400))]),
            userRow(3, "last"),
        ]);
        const prepared = (await ClaudeSession.fromFile(path)).toPromptContent({
            tokenBudget: 150,
            priority: "assistant-first",
        });

        expect(prepared.truncated).toBe(true);
        expect(prepared.truncationInfo).toBe(
            "Included 3 of 4 messages (assistant-first priority). Budget: 150 tokens."
        );
        expect(prepared.content).toContain("x".repeat(400));
        expect(prepared.content).not.toContain("y");
        expect(prepared.content.startsWith("[User]: first")).toBe(true);
        expect(prepared.content.endsWith("[User]: last")).toBe(true);
    });

    it("returns only the cut bookends when they alone exceed the budget", async () => {
        const path = writeJsonl(join(projectsDir, "-fmt", "tiny.jsonl"), [
            userRow(0, "first message"),
            userRow(1, "last message"),
        ]);
        const prepared = (await ClaudeSession.fromFile(path)).toPromptContent({
            tokenBudget: 2,
            priority: "user-first",
        });

        // 2 tokens allow 8 characters of the joined bookend text
        expect(prepared.content).toBe("[User]: ");
        expect(prepared.truncated).toBe(true);
        expect(prepared.truncationInfo).toBe(
            "Session has 2 messages; only bookend messages fit within 2 token budget."
        );
    });

    it("handles a session with a single message", async () => {
        const path = writeJsonl(join(projectsDir, "-fmt", "single.jsonl"), [userRow(0, "only one")]);
        const prepared = (await ClaudeSession.fromFile(path)).toPromptContent({
            tokenBudget: 100,
            priority: "user-first",
        });

        expect(prepared.content).toBe("[User]: only one");
        expect(prepared.truncated).toBe(false);
        expect(prepared.stats.userMessages).toBe(1);
    });
});

describe("ClaudeSession.toPromptContent summary-aware priorities", () => {
    // Every middle message is 44 characters, which is 11 estimated tokens. The bookends and summaries cost 4, 3, 4, 4.
    const body = "m".repeat(36);
    const rows: Row[] = [
        userRow(0, "first"),
        userRow(1, `${body}`.replace("m", "1")),
        { type: "summary", summary: "S1", leafUuid: "a" },
        userRow(3, `${body}`.replace("m", "3")),
        userRow(4, `${body}`.replace("m", "4")),
        { type: "summary", summary: "S2", leafUuid: "b" },
        userRow(6, `${body}`.replace("m", "6")),
        userRow(7, `${body}`.replace("m", "7")),
        userRow(8, "last"),
    ];

    function marks(content: string): string[] {
        return content.split("\n\n").map((part) => part.replace("[User]: ", "").slice(0, 1));
    }

    async function summarySession(): Promise<Session> {
        return ClaudeSession.fromFile(writeJsonl(join(projectsDir, "-sum", "summary.jsonl"), rows));
    }

    it("includes everything in chronological order when the budget is large", async () => {
        const prepared = (await summarySession()).toPromptContent({ tokenBudget: 5000, priority: "balanced" });

        expect(marks(prepared.content)).toEqual(["f", "1", "[", "3", "4", "[", "6", "7", "l"]);
        expect(prepared.truncated).toBe(false);
        expect(prepared.truncationInfo).toBe("All 9 messages included within 5000 token budget.");
    });

    it("balanced gives 70% of the spare budget to messages after the last summary", async () => {
        const prepared = (await summarySession()).toPromptContent({ tokenBudget: 45, priority: "balanced" });

        expect(marks(prepared.content)).toEqual(["f", "1", "[", "[", "7", "l"]);
        expect(prepared.truncationInfo).toBe(
            "Included 6 of 9 messages (balanced: 2 summaries + 1 recent + 1 early). Budget: 45 tokens."
        );
    });

    it("summary-first gives 85% of the spare budget to messages after the last summary", async () => {
        const prepared = (await summarySession()).toPromptContent({ tokenBudget: 45, priority: "summary-first" });

        expect(marks(prepared.content)).toEqual(["f", "[", "[", "6", "7", "l"]);
        expect(prepared.truncationInfo).toBe(
            "Included 6 of 9 messages (summary-first: 2 summaries + 2 recent + 0 early). Budget: 45 tokens."
        );
    });

    it("keeps only the leading summaries and bookends that fit when they exceed the budget", async () => {
        const prepared = (await summarySession()).toPromptContent({ tokenBudget: 8, priority: "balanced" });

        expect(prepared.content).toBe("[User]: first\n\n[Summary]: S1");
        expect(prepared.truncated).toBe(true);
        expect(prepared.truncationInfo).toBe(
            "Session has 9 messages; only summaries + bookends fit within 8 token budget."
        );
    });

    it("treats the newest 70% of messages as recent when the session has no summary", async () => {
        const path = writeJsonl(join(projectsDir, "-sum", "plain.jsonl"), [
            userRow(0, "first"),
            userRow(1, `${body}`.replace("m", "1")),
            userRow(2, `${body}`.replace("m", "2")),
            userRow(3, `${body}`.replace("m", "3")),
            userRow(4, `${body}`.replace("m", "4")),
            userRow(5, "last"),
        ]);
        const prepared = (await ClaudeSession.fromFile(path)).toPromptContent({
            tokenBudget: 37,
            priority: "balanced",
        });

        expect(marks(prepared.content)).toEqual(["f", "4", "l"]);
        expect(prepared.truncationInfo).toBe(
            "Included 3 of 6 messages (balanced: 0 summaries + 1 recent + 0 early). Budget: 37 tokens."
        );
    });

    it("returns empty content for an empty session", async () => {
        const session = await ClaudeSession.fromFile(join(projectsDir, "-sum", "absent.jsonl"));
        const prepared = session.toPromptContent({ tokenBudget: 100, priority: "balanced" });

        expect(prepared.content).toBe("");
        expect(prepared.truncated).toBe(false);
        expect(prepared.stats).toEqual({ userMessages: 0, assistantMessages: 0, toolCalls: 0, filesModified: [] });
    });
});

describe("ClaudeSession.fromSessionId", () => {
    const exactId = "ab12cd34-0000-4000-8000-00000000e0e0";
    const prefixId = "cd34ef56-0000-4000-8000-00000000f1f1";
    const nestedId = "ef56ab78-0000-4000-8000-0000000000a2";
    const elsewhereId = "12ab34cd-0000-4000-8000-0000000000b3";
    const currentId = "34cd56ef-0000-4000-8000-0000000000c4";

    beforeAll(() => {
        writeJsonl(join(projectsDir, "-gt-id-main", `${exactId}.jsonl`), [
            { type: "custom-title", customTitle: "exact", sessionId: exactId },
        ]);
        writeJsonl(join(projectsDir, "-gt-id-main", `${prefixId}.jsonl`), [
            { type: "custom-title", customTitle: "prefix", sessionId: prefixId },
        ]);
        writeJsonl(join(projectsDir, "-gt-id-main", "subagents", `${nestedId}.jsonl`), [
            { type: "custom-title", customTitle: "nested", sessionId: nestedId },
        ]);
        writeJsonl(join(projectsDir, "-gt-id-other", `${elsewhereId}.jsonl`), [
            { type: "custom-title", customTitle: "elsewhere", sessionId: elsewhereId },
        ]);
        writeJsonl(join(projectsDir, "-work-current", `${currentId}.jsonl`), [
            { type: "custom-title", customTitle: "current", sessionId: currentId },
        ]);
    });

    it("finds a session by its exact id in the given project folder", async () => {
        const session = await ClaudeSession.fromSessionId(exactId, "-gt-id-main");

        expect(session.title).toBe("exact");
    });

    it("finds a session by an id prefix, ignoring case", async () => {
        const session = await ClaudeSession.fromSessionId("CD34EF56", "-gt-id-main");

        expect(session.title).toBe("prefix");
    });

    it("also looks inside the subagents folder of the project", async () => {
        const session = await ClaudeSession.fromSessionId("ef56ab78", "-gt-id-main");

        expect(session.title).toBe("nested");
        expect(session.isSubagent).toBe(true);
    });

    it("searches the current project first and then every other project when no folder is given", async () => {
        expect((await ClaudeSession.fromSessionId("34cd56ef")).title).toBe("current");
        expect((await ClaudeSession.fromSessionId("12ab34cd")).title).toBe("elsewhere");
    });

    it("does not leave the named project when the id is not there", async () => {
        await expect(ClaudeSession.fromSessionId("12ab34cd", "-gt-id-main")).rejects.toThrow(
            'No session file found for ID prefix "12ab34cd"'
        );
    });

    it("rejects an id that no project holds", async () => {
        await expect(ClaudeSession.fromSessionId("ffffffff")).rejects.toThrow("also searched all projects");
    });
});

describe("ClaudeSession.findSessions", () => {
    const alphaId = "aaaaaaaa-1111-4111-8111-111111111111";
    const olderId = "bbbbbbbb-2222-4222-8222-222222222222";
    const emptyId = "cccccccc-3333-4333-8333-333333333333";
    const newestId = "eeeeeeee-5555-4555-8555-555555555555";
    let alphaPath: string;

    beforeAll(() => {
        const alpha = join(projectsDir, "-gt-fs-alpha");
        alphaPath = writeJsonl(join(alpha, `${alphaId}.jsonl`), [
            { type: "custom-title", customTitle: "Alpha title", sessionId: alphaId },
            { type: "summary", summary: "Alpha summary", leafUuid: "l" },
            {
                type: "user",
                sessionId: alphaId,
                timestamp: at(10),
                gitBranch: "main",
                message: { role: "user", content: "hi" },
            },
            "garbage that is not json",
            {
                type: "assistant",
                sessionId: alphaId,
                timestamp: at(20),
                gitBranch: "feat/newer",
                message: { role: "assistant", content: [] },
            },
        ]);
        writeJsonl(join(alpha, `${olderId}.jsonl`), [
            { type: "user", sessionId: olderId, timestamp: at(-120), message: { role: "user", content: "old" } },
        ]);
        writeJsonl(join(alpha, `${emptyId}.jsonl`), []);
        writeJsonl(join(alpha, "agent-dddddddd.jsonl"), [
            { type: "user", sessionId: "dddddddd", timestamp: at(15), message: { role: "user", content: "agent" } },
        ]);
        writeJsonl(join(alpha, alphaId, "subagents", "agent-ffffffff.jsonl"), [
            {
                type: "user",
                sessionId: "ffffffff",
                timestamp: at(16),
                message: { role: "user", content: "nested agent" },
            },
        ]);
        writeJsonl(join(projectsDir, "-gt-fs-beta", `${newestId}.jsonl`), [
            { type: "user", sessionId: newestId, timestamp: at(60), message: { role: "user", content: "new" } },
        ]);
    });

    it("lists main sessions newest first with the metadata from the first and last lines", async () => {
        const sessions = await ClaudeSession.findSessions({ project: "gt-fs" });

        expect(sessions.map((s) => s.sessionId)).toEqual([newestId, alphaId, olderId, emptyId]);

        const alpha = sessions[1];
        expect(alpha.filePath).toBe(alphaPath);
        expect(alpha.title).toBe("Alpha title");
        expect(alpha.summary).toBe("Alpha summary");
        expect(alpha.gitBranch).toBe("feat/newer");
        expect(alpha.startDate?.toISOString()).toBe(at(10));
        expect(alpha.lastTimestamp?.toISOString()).toBe(at(20));
        expect(alpha.messageCount).toBe(5);
        expect(alpha.fileSize).toBeGreaterThan(0);
        expect(alpha.isSubagent).toBe(false);
    });

    it("falls back to the file name for the id and leaves dates empty when a file has no records", async () => {
        const sessions = await ClaudeSession.findSessions({ project: "gt-fs" });
        const empty = sessions.find((s) => s.sessionId === emptyId);

        expect(empty?.startDate).toBeNull();
        expect(empty?.lastTimestamp).toBeNull();
        expect(empty?.title).toBeNull();
        expect(empty?.messageCount).toBe(0);
    });

    it("counts the lines of a small session exactly", async () => {
        const dir = join(projectsDir, "-gt-count-small");
        const lines = Array.from({ length: 24 }, (_, i) => userRow(i, `line ${i}`));
        writeJsonl(join(dir, "11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jsonl"), lines);

        const [session] = await ClaudeSession.findSessions({ project: "gt-count-small" });

        expect(session.messageCount).toBe(24);
    });

    it("estimates the line count of a large session from its size instead of stopping at the 25 lines it read", async () => {
        const dir = join(projectsDir, "-gt-count-big");
        // Every line is 300 bytes with its newline, the average the estimate assumes.
        const padded = (i: number) => {
            const row = userRow(i % 60, "");
            const bare = SafeJSON.stringify(row).length;

            return userRow(i % 60, "x".repeat(299 - bare));
        };
        const lines = Array.from({ length: 100 }, (_, i) => padded(i));
        writeJsonl(join(dir, "22222222-bbbb-4bbb-8bbb-bbbbbbbbbbbb.jsonl"), lines);

        const [session] = await ClaudeSession.findSessions({ project: "gt-count-big" });

        expect(session.messageCount).toBe(100);
    });

    it("counts a complete 25-line file exactly, however long its lines are", async () => {
        const dir = join(projectsDir, "-gt-count-exact");
        // 2 KB lines: a size estimate would read this file as about 170 messages.
        const lines = Array.from({ length: 25 }, (_, i) => userRow(i % 60, "y".repeat(2_000)));
        writeJsonl(join(dir, "33333333-cccc-4ccc-8ccc-cccccccccccc.jsonl"), lines);

        const [session] = await ClaudeSession.findSessions({ project: "gt-count-exact" });

        expect(session.messageCount).toBe(25);
    });

    it("applies since, until and limit to the start date", async () => {
        const since = await ClaudeSession.findSessions({ project: "gt-fs", since: new Date(at(0)) });
        const until = await ClaudeSession.findSessions({ project: "gt-fs", until: new Date(at(30)) });
        const limited = await ClaudeSession.findSessions({ project: "gt-fs", limit: 2 });

        expect(since.map((s) => s.sessionId)).toEqual([newestId, alphaId, emptyId]);
        expect(until.map((s) => s.sessionId)).toEqual([alphaId, olderId, emptyId]);
        expect(limited.map((s) => s.sessionId)).toEqual([newestId, alphaId]);
    });

    it("scopes an encoded project name to that folder only", async () => {
        const sessions = await ClaudeSession.findSessions({ project: "-gt-fs-alpha" });

        expect(sessions.map((s) => s.sessionId)).toEqual([alphaId, olderId, emptyId]);
    });

    it("adds subagent transcripts, flagged as such, when asked", async () => {
        const sessions = await ClaudeSession.findSessions({ project: "gt-fs", includeSubagents: true });
        const agents = sessions.filter((s) => s.isSubagent).map((s) => basename(s.filePath));

        expect(agents.sort()).toEqual(["agent-dddddddd.jsonl", "agent-ffffffff.jsonl"]);
        expect(sessions).toHaveLength(6);
    });

    it("searches every project folder with allProjects", async () => {
        const sessions = await ClaudeSession.findSessions({ allProjects: true });

        expect(sessions.map((s) => s.sessionId)).toContain(newestId);
        expect(sessions.map((s) => s.sessionId)).toContain(alphaId);
    });
});

describe("ClaudeSession.findSubagents", () => {
    const leadId = "5e550001-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const otherLeadId = "5e550002-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const subDir = join(projectsDir, "-work-sub", leadId, "subagents");
    const otherDir = join(projectsDir, "-work-sub", otherLeadId, "subagents");

    function agent(dir: string, id: string, meta: Row | string | null, mtimeSeconds: number): void {
        const jsonl = writeJsonl(join(dir, `agent-${id}.jsonl`), [
            { type: "user", message: { role: "user", content: id } },
        ]);
        utimesSync(jsonl, mtimeSeconds, mtimeSeconds);

        if (meta !== null) {
            writeFileSync(
                join(dir, `agent-${id}.meta.json`),
                typeof meta === "string" ? meta : SafeJSON.stringify(meta)
            );
        }
    }

    beforeAll(() => {
        agent(
            subDir,
            "a1b2c3",
            { agentType: "Explore", description: "Find usages of invoice", name: "explorer" },
            1_000
        );
        agent(subDir, "d4e5f6", { agentType: "general", description: "Write migration notes" }, 3_000);
        agent(subDir, "0badbad", "{ not json", 2_000);
        writeFileSync(
            join(subDir, "agent-orphan.meta.json"),
            SafeJSON.stringify({ agentType: "x", description: "no transcript" })
        );
        agent(otherDir, "77aa88", { agentType: "general", description: "Other session helper" }, 4_000);
    });

    it("lists a project's subagents newest first, labelled by their description", () => {
        const targets = ClaudeSession.findSubagents({ project: "/work/sub" });

        expect(targets.map((t) => t.agentId)).toEqual(["77aa88", "d4e5f6", "0badbad", "a1b2c3"]);
        expect(targets[1]).toEqual({
            filePath: join(subDir, "agent-d4e5f6.jsonl"),
            label: "Write migration notes",
            sessionId: leadId,
            agentId: "d4e5f6",
            agentDescription: "Write migration notes",
            isAgent: true,
        });
    });

    it("labels an agent by its id when the meta file is unreadable and skips metas without a transcript", () => {
        const targets = ClaudeSession.findSubagents({ project: "/work/sub" });
        const broken = targets.find((t) => t.agentId === "0badbad");

        expect(broken?.label).toBe("agent-0badbad");
        expect(broken?.agentDescription).toBeUndefined();
        expect(targets.map((t) => t.agentId)).not.toContain("orphan");
    });

    it("limits the scan to sessions whose id starts with the given prefix", () => {
        const targets = ClaudeSession.findSubagents({ project: "/work/sub", sessionId: "5E550002" });

        expect(targets.map((t) => t.agentId)).toEqual(["77aa88"]);
    });

    it("matches the query against agent id, name and description, ignoring case", () => {
        const find = (query: string) =>
            ClaudeSession.findSubagents({ project: "/work/sub", query }).map((t) => t.agentId);

        expect(find("A1B2")).toEqual(["a1b2c3"]);
        expect(find("EXPLORER")).toEqual(["a1b2c3"]);
        expect(find("migration")).toEqual(["d4e5f6"]);
        expect(find("nothing matches this")).toEqual([]);
    });

    it("returns nothing for a project that has no folder", () => {
        expect(ClaudeSession.findSubagents({ project: "/work/never-existed" })).toEqual([]);
    });

    it("scans every project folder with allProjects", () => {
        const targets = ClaudeSession.findSubagents({ allProjects: true, query: "other session" });

        expect(targets.map((t) => t.agentId)).toEqual(["77aa88"]);
        expect(ClaudeSession.findSubagents({ allProjects: true, sessionId: leadId }).map((t) => t.agentId)).toEqual([
            "d4e5f6",
            "0badbad",
            "a1b2c3",
        ]);
    });
});
