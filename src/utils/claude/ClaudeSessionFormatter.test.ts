import { describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatDateTime } from "@genesiscz/utils/date";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import { stripAnsi } from "@genesiscz/utils/string";
import { ClaudeSessionFormatter } from "./ClaudeSessionFormatter";
import { IncludeSpec } from "./cli/dsl";
import type { TailTarget } from "./session.types";
import type { ConversationMessage } from "./types";

type Row = Record<string, unknown>;
type FormatterOptions = ConstructorParameters<typeof ClaudeSessionFormatter>[0];

const TS = "2026-03-01T10:00:00.000Z";
/**
 * The clock text the formatter prints for TS. It follows the system locale and zone ("11:00:00" in Prague with a
 * Czech locale, "10:00:00 AM" on the UTC runner, whose LANG=C.UTF-8 leaves Intl at en-US), so it is computed.
 */
const CLOCK = new RegExp(formatDateTime(TS, { absolute: "time-seconds" }).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));

/** A record the way it arrives from a JSONL line. */
function rec(row: Row): ConversationMessage {
    return SafeJSON.parse(SafeJSON.stringify(row));
}

function envelope(extra: Row = {}): Row {
    return { uuid: "u", parentUuid: null, sessionId: "s", timestamp: TS, userType: "external", ...extra };
}

function user(content: unknown, extra: Row = {}): ConversationMessage {
    return rec({ type: "user", ...envelope(extra), message: { role: "user", content } });
}

function assistantMessage(content: unknown[], stop: string | null = null): Row {
    return {
        role: "assistant",
        id: "m",
        type: "message",
        model: "claude-test-1",
        stop_reason: stop,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
        content,
    };
}

function assistant(content: unknown[]): ConversationMessage {
    return rec({ type: "assistant", ...envelope(), message: assistantMessage(content) });
}

function text(value: string): Row {
    return { type: "text", text: value };
}

function toolUse(name: string, input: Row): Row {
    return { type: "tool_use", id: "t", name, input };
}

function toolResult(content: unknown, isError = false): Row {
    return { type: "tool_result", tool_use_id: "t", content, ...(isError ? { is_error: true } : {}) };
}

function subagentUser(content: unknown, agentId = "agent-1"): ConversationMessage {
    return rec({ type: "subagent", ...envelope({ agentId }), role: "user", message: { role: "user", content } });
}

function subagentAssistant(content: unknown[], stop: string | null = null, agentId = "agent-1"): ConversationMessage {
    return rec({
        type: "subagent",
        ...envelope({ agentId }),
        role: "assistant",
        message: assistantMessage(content, stop),
    });
}

function make(overrides: Partial<FormatterOptions> = {}): { formatter: ClaudeSessionFormatter; lines: string[] } {
    const lines: string[] = [];
    const formatter = new ClaudeSessionFormatter({
        includeSpec: IncludeSpec.defaults(),
        colors: false,
        output: (line) => lines.push(stripAnsi(line)),
        ...overrides,
    });

    return { formatter, lines };
}

const plain = (lines: string[]): string[] => lines.map(stripAnsi);

describe("ClaudeSessionFormatter raw and ignored records", () => {
    it("writes the record as one compact JSON line in raw mode", () => {
        const { formatter, lines } = make({ raw: true });
        const record = user("hello");

        formatter.format(record);

        expect(lines).toHaveLength(1);
        expect(SafeJSON.parse(lines[0])).toEqual(record);
        expect(lines[0]).not.toContain("\n");
    });

    it("prints nothing for system, summary, custom-title and plain progress records", () => {
        const { formatter, lines } = make();

        formatter.format(rec({ type: "system", ...envelope(), subtype: "turn_duration" }));
        formatter.format(rec({ type: "summary", summary: "s", leafUuid: "l" }));
        formatter.format(rec({ type: "custom-title", customTitle: "t", sessionId: "s" }));
        formatter.format(
            rec({
                type: "progress",
                ...envelope(),
                toolUseID: "a",
                parentToolUseID: "b",
                data: { type: "hook_progress", hookEvent: "e", hookName: "n", command: "c" },
            })
        );

        expect(lines).toEqual([]);
    });

    it("prefixes every line with the indent option", () => {
        const { formatter, lines } = make({ indent: ">> " });

        formatter.format(user("hello"));

        expect(lines).toEqual([">> ❯ hello"]);
    });
});

describe("ClaudeSessionFormatter user messages", () => {
    it("prints the first line after the prompt marker and indents the rest", () => {
        const { formatter, lines } = make();

        formatter.format(user("first line\nsecond line\nthird line"));

        expect(lines).toEqual(["❯ first line", "  second line", "  third line"]);
    });

    it("prefixes the clock time when timestamps are on", () => {
        const { formatter, lines } = make({ timestamps: true });

        formatter.format(user("a\nb"));

        expect(lines[0]).toMatch(new RegExp(`^${CLOCK.source} ❯ a$`));
        expect(lines[1]).toBe("         b");
    });

    it("shows ??:??:?? when the timestamp cannot be formatted", () => {
        const { formatter, lines } = make({ timestamps: true });

        formatter.format(user("a", { timestamp: "not a date" }));

        expect(lines[0]).toBe("??:??:?? ❯ a");
    });

    it("removes system-reminder blocks and prints nothing when only a reminder is left", () => {
        const { formatter, lines } = make();

        formatter.format(user("<system-reminder>internal</system-reminder>Real question"));
        formatter.format(user("<system-reminder>only noise</system-reminder>"));

        expect(lines).toEqual(["❯ Real question"]);
    });

    it("skips meta messages and blank messages", () => {
        const { formatter, lines } = make();

        formatter.format(user("injected context", { isMeta: true }));
        formatter.format(user("   \n  "));
        formatter.format(user([{ type: "image", source: { type: "base64", media_type: "image/png", data: "A" } }]));

        expect(lines).toEqual([]);
    });

    it("turns a task notification into a one-line agent status", () => {
        const { formatter, lines } = make();
        const notification = (status: string) =>
            `<task-notification><task-id>abcdef123456</task-id><status>${status}</status><summary>Review finished</summary></task-notification>`;

        formatter.format(user(notification("completed")));
        formatter.format(user(notification("running")));
        formatter.format(user("<task-notification>nothing else</task-notification>"));

        expect(lines).toEqual([
            "  ✓ Agent abcdef12: Review finished",
            "  … Agent abcdef12: Review finished",
            "  … Agent unknown: agent task",
        ]);
    });

    it("joins the text blocks of a block message", () => {
        const { formatter, lines } = make();

        formatter.format(user([text("one"), text("two")]));

        expect(lines).toEqual(["❯ one", "  two"]);
    });

    it("prints a tool result under the tool line, truncated to the tools:out length", () => {
        const { formatter, lines } = make({ includeSpec: IncludeSpec.parse("tools:out:20") });

        formatter.format(user([toolResult("short result")]));
        formatter.format(user([toolResult("0123456789012345678901234567890")]));
        formatter.format(user([toolResult([text("array"), text("result")])]));

        expect(plain(lines)).toEqual(["  ⎿ short result", "  ⎿ 01234567890123456...", "  ⎿ array\nresult"]);
    });

    it("hides tool results when tools:out is not included", () => {
        const { formatter, lines } = make({ includeSpec: IncludeSpec.parse("thinking") });

        formatter.format(user([toolResult("hidden")]));

        expect(lines).toEqual([]);
    });

    it("summarises an agent completion instead of dumping its result", () => {
        const { formatter, lines } = make();
        const result =
            "agentId: abcdef1234567 (resumable)\nDone.\n<usage>total_tokens: 345\ntool_uses: 7\nduration_ms: 83000</usage>";

        formatter.format(user([toolResult(result)]));

        expect(lines).toEqual(["  ⏱ Agent abcdef12: 1m 23s, 7 tools, 345 tokens"]);
    });

    it("formats agent durations under a second and under a minute", () => {
        const { formatter, lines } = make();
        const usage = (ms: number) =>
            `agentId: a1b2c3d4e5 (x)\n<usage>total_tokens: 1\ntool_uses: 2\nduration_ms: ${ms}</usage>`;

        formatter.format(user([toolResult(usage(450))]));
        formatter.format(user([toolResult(usage(12_000))]));

        expect(lines).toEqual([
            "  ⏱ Agent a1b2c3d4: 450ms, 2 tools, 1 tokens",
            "  ⏱ Agent a1b2c3d4: 12s, 2 tools, 1 tokens",
        ]);
    });

    it("shows an agent result as plain tool output when agents:result is not included", () => {
        const { formatter, lines } = make({ includeSpec: IncludeSpec.parse("tools:out:200") });

        formatter.format(
            user([toolResult("agentId: abc (x)\n<usage>total_tokens: 1\ntool_uses: 2\nduration_ms: 3</usage>")])
        );

        expect(plain(lines)[0]).toStartWith("  ⎿ agentId: abc");
    });

    it("renders tool output through the markdown renderer when colors are on", () => {
        const { formatter, lines } = make({ colors: true });

        formatter.format(user([toolResult("**bold** result")]));
        formatter.format(user([toolResult("failed hard", true)]));

        expect(plain(lines)).toEqual(["  ⎿ bold result", "  ⎿ failed hard"]);
    });
});

describe("ClaudeSessionFormatter assistant messages", () => {
    it("prints text with a marker and keeps blank lines between paragraphs", () => {
        const { formatter, lines } = make();

        formatter.format(assistant([text("first paragraph\n\nsecond paragraph")]));

        expect(lines).toEqual(["⏺ first paragraph", "", "  second paragraph"]);
    });

    it("prints only the first line of thinking, and only when thinking is included", () => {
        const withThinking = make();
        const withoutThinking = make({ includeSpec: IncludeSpec.parse("tools:in:100") });
        const blocks = [
            { type: "thinking", thinking: "  plan A\nplan B  " },
            { type: "thinking", thinking: "   " },
        ];

        withThinking.formatter.format(assistant(blocks));
        withoutThinking.formatter.format(assistant(blocks));

        expect(withThinking.lines).toEqual(["∴ plan A"]);
        expect(withoutThinking.lines).toEqual([]);
    });

    it("prints a tool call as a signature, aligned under the text that came before it", () => {
        const { formatter, lines } = make();

        formatter.format(assistant([toolUse("Read", { file_path: "/a/b.ts" })]));
        formatter.format(assistant([text("Reading."), toolUse("Bash", { command: "ls -la", description: "list" })]));

        expect(lines).toEqual([" ⏺ Read(/a/b.ts)", "⏺ Reading.", "  ⏺ Bash(ls -la, description: list)"]);
    });

    it("shows the diff of an edit or a write under its signature", () => {
        const { formatter, lines } = make();

        formatter.format(
            assistant([toolUse("Edit", { file_path: "/f.ts", old_string: "alpha\n", new_string: "beta\n" })])
        );
        formatter.format(assistant([toolUse("Write", { file_path: "/g.ts", content: "fresh file" })]));

        expect(lines).toEqual([
            " ⏺ Edit(/f.ts)",
            "   @@ -1,1 +1,1 @@",
            "   -alpha",
            "   +beta",
            " ⏺ Write(/g.ts)",
            "   + fresh file",
        ]);
    });

    it("leaves out the diff when the tools:in length is 500 or less", () => {
        const { formatter, lines } = make({ includeSpec: IncludeSpec.parse("tools:in:500") });

        formatter.format(assistant([toolUse("Edit", { file_path: "/f.ts", old_string: "a\n", new_string: "b\n" })]));

        expect(lines).toEqual([" ⏺ Edit(/f.ts)"]);
    });

    it("hides tool calls when tools:in is not included", () => {
        const { formatter, lines } = make({ includeSpec: IncludeSpec.parse("thinking") });

        formatter.format(assistant([toolUse("Read", { file_path: "/a/b.ts" })]));

        expect(lines).toEqual([]);
    });

    it("prefixes the clock time on text, thinking and tool lines when timestamps are on", () => {
        const { formatter, lines } = make({ timestamps: true });

        formatter.format(
            assistant([{ type: "thinking", thinking: "hm" }, text("Hi"), toolUse("Read", { file_path: "/a.ts" })])
        );

        expect(lines[0]).toMatch(new RegExp(`^${CLOCK.source} ∴ hm$`));
        expect(lines[1]).toMatch(new RegExp(`^${CLOCK.source} ⏺ Hi$`));
        expect(lines[2]).toBe("         ⏺ Read(/a.ts)");
    });

    it("colors tool names and renders markdown text when colors are on", () => {
        const { formatter, lines } = make({ colors: true });

        formatter.format(
            assistant([
                { type: "thinking", thinking: "deep" },
                text("**bold** answer"),
                toolUse("Edit", { file_path: "/f.ts", old_string: "a\n", new_string: "b\n" }),
                toolUse("Agent", { description: "helper" }),
                toolUse("Mystery", {}),
            ])
        );

        expect(plain(lines)).toEqual([
            "∴ deep",
            "⏺ bold answer",
            "  ⏺ Edit(/f.ts)",
            "   @@ -1,1 +1,1 @@",
            "   -a",
            "   +b",
            "  ⏺ Agent(helper)",
            "  ⏺ Mystery()",
        ]);
    });

    it("accepts the shorthand A record some sessions use for assistant messages", () => {
        const { formatter, lines } = make();

        formatter.format(rec({ type: "A", timestamp: TS, message: assistantMessage([text("legacy reply")]) }));
        formatter.format(rec({ type: "A" }));

        expect(lines).toEqual(["⏺ legacy reply"]);
    });

    it("ignores an assistant record whose content is not a list", () => {
        const { formatter, lines } = make();

        formatter.format(rec({ type: "assistant", ...envelope(), message: { role: "assistant", content: "oops" } }));

        expect(lines).toEqual([]);
    });

    it("puts a blank line between a user turn and the assistant turn that follows", () => {
        const { formatter, lines } = make();

        formatter.format(user("question"));
        formatter.format(assistant([text("answer")]));
        formatter.format(assistant([text("more")]));
        formatter.format(user("next"));

        expect(lines).toEqual(["❯ question", "", "⏺ answer", "⏺ more", "", "❯ next"]);
    });
});

describe("ClaudeSessionFormatter mini mode", () => {
    it("collapses user text to one line with an actor icon", () => {
        const { formatter, lines } = make({ mode: "mini" });

        formatter.format(user("line one\n\nline two"));

        expect(lines).toEqual(["🧑 line one line two"]);
    });

    it("truncates long text to maxCharsPerMessage", () => {
        const { formatter, lines } = make({ mode: "mini", maxCharsPerMessage: 12 });

        formatter.format(user("abcdefghijklmnopqrstuvwxyz"));

        expect(lines).toEqual(["🧑 abcdefghi..."]);
    });

    it("prints assistant text and tool calls on separate lines without blank lines between turns", () => {
        const { formatter, lines } = make({ mode: "mini" });

        formatter.format(user("go"));
        formatter.format(
            assistant([
                text("part one\npart two"),
                toolUse("Read", { file_path: "/a.ts" }),
                toolUse("Bash", { command: "ls" }),
            ])
        );

        expect(lines).toEqual(["🧑 go", "🤖 part one part two", "   ◆ Read(/a.ts)", "   ◆ Bash(ls)"]);
    });

    it("drops the icons when actorIcons is off", () => {
        const { formatter, lines } = make({ mode: "mini", actorIcons: false });

        formatter.format(user("hi"));
        formatter.format(assistant([text("yo"), toolUse("Read", { file_path: "/a.ts" })]));

        expect(lines).toEqual(["hi", "yo", "  ◆ Read(/a.ts)"]);
    });

    it("does not print tool results", () => {
        const { formatter, lines } = make({ mode: "mini" });

        formatter.format(user([toolResult("secret output")]));

        expect(lines).toEqual([]);
    });

    it("colors mini output when colors are on", () => {
        const { formatter, lines } = make({ mode: "mini", colors: true });

        formatter.format(user("hi"));
        formatter.format(assistant([text("yo"), toolUse("Grep", { pattern: "x" }), toolUse("Mystery", {})]));

        expect(plain(lines)).toEqual(["🧑 hi", "🤖 yo", "   ◆ ⏺ Grep(x)", "   ◆ ⏺ Mystery()"]);
    });
});

describe("ClaudeSessionFormatter agent sections", () => {
    const closing = /^ {2}└─+ ✓ done \(\d+ms\) ─$/;

    it("opens a bordered section for a subagent prompt and fills it with the agent's work", () => {
        const { formatter, lines } = make();

        formatter.format(subagentUser("Find the billing code\nand report"));
        formatter.format(
            subagentAssistant([
                { type: "thinking", thinking: "look around" },
                text("Found it.\nDetails"),
                toolUse("Grep", { pattern: "bill" }),
            ])
        );

        expect(lines[0]).toBe("");
        expect(lines[1]).toMatch(new RegExp(`^${CLOCK.source} ⏺ Agent\\(Find the billing code\\)$`));
        expect(lines[2]).toBe(`  ┌─ Find the billing code ${"─".repeat(29)}`);
        expect(lines[3]).toMatch(new RegExp(`^  │ ${CLOCK.source} ∴ look around$`));
        expect(lines[4]).toMatch(new RegExp(`^  │ ${CLOCK.source} ⏺ Found it\\.$`));
        expect(lines[5]).toBe("  │   ⏺ Grep(bill)");
        expect(lines).toHaveLength(6);
    });

    it("closes the section with the elapsed time when the agent ends its turn", () => {
        const { formatter, lines } = make();

        formatter.format(subagentUser("Task"));
        formatter.format(subagentAssistant([text("ok")], "end_turn"));

        expect(lines.at(-1)).toMatch(closing);
    });

    it("closes the open section when the parent conversation resumes", () => {
        const { formatter, lines } = make();

        formatter.format(subagentUser("Task"));
        formatter.format(assistant([text("Back in the parent")]));

        expect(lines.at(-2)).toMatch(closing);
        expect(lines.at(-1)).toBe("⏺ Back in the parent");
    });

    it("keeps the section open across hook progress records", () => {
        const { formatter, lines } = make();

        formatter.format(subagentUser("Task"));
        formatter.format(
            rec({
                type: "progress",
                ...envelope(),
                toolUseID: "a",
                parentToolUseID: "b",
                data: { type: "hook_progress", hookEvent: "e", hookName: "n", command: "c" },
            })
        );
        formatter.close();

        expect(lines.filter((line) => closing.test(line))).toHaveLength(1);
    });

    it("closes the previous section when a different agent starts", () => {
        const { formatter, lines } = make();

        formatter.format(subagentUser("First task", "agent-1"));
        formatter.format(subagentUser("Second task", "agent-2"));

        expect(lines.filter((line) => closing.test(line))).toHaveLength(1);
        expect(lines.some((line) => line.includes("Agent(Second task)"))).toBe(true);
    });

    it("turns agent_progress records into subagent output", () => {
        const { formatter, lines } = make();

        formatter.format(
            rec({
                type: "progress",
                ...envelope(),
                toolUseID: "a",
                parentToolUseID: "b",
                data: {
                    type: "agent_progress",
                    agentId: "agent-9",
                    message: { type: "user", message: { role: "user", content: "Check the logs" } },
                },
            })
        );

        expect(lines.some((line) => line.includes("Agent(Check the logs)"))).toBe(true);
    });

    it("prints plain one-line agent markers without a border", () => {
        const { formatter, lines } = make({ border: false });

        formatter.format(subagentUser("Task description"));
        formatter.format(subagentAssistant([text("working")]));
        formatter.closeAgentSection();

        expect(lines[0]).toBe('  ◆ Agent → "Task description"');
        expect(lines[1]).toMatch(new RegExp(`^    ${CLOCK.source} ⏺ working$`));
        expect(lines).toHaveLength(2);
    });

    it("uses the narrower padding in mini mode with actor icons", () => {
        const { formatter, lines } = make({ mode: "mini" });

        formatter.format(subagentUser("Task description"));

        expect(lines).toEqual(['   ◆ Agent → "Task description"']);
    });

    it("prints subagent tool results under their agent and ignores empty prompts", () => {
        const { formatter, lines } = make({ border: false });

        formatter.format(subagentUser([toolResult("result text"), toolResult("failed", true), toolResult("")]));
        formatter.format(subagentUser("   "));

        expect(plain(lines)).toEqual(["      ⎿ result text", "      ⎿ failed"]);
    });

    it("renders subagent output with markdown and colors when colors are on", () => {
        const { formatter, lines } = make({ colors: true });

        formatter.format(subagentUser([toolResult("**ok** done")]));
        formatter.format(subagentAssistant([text("done")]));

        expect(plain(lines)[0]).toBe("      ⎿ ok done");
        expect(plain(lines).some((line) => line.includes("⏺ done"))).toBe(true);
    });

    it("shows subagent diffs for edits and writes", () => {
        const { formatter, lines } = make({ border: false });

        formatter.format(
            subagentAssistant([toolUse("Edit", { file_path: "/f.ts", old_string: "a\n", new_string: "b\n" })])
        );

        expect(lines).toEqual(["      ⏺ Edit(/f.ts)", "        @@ -1,1 +1,1 @@", "        -a", "        +b"]);
    });

    it("respects the agents:* switches", () => {
        const { formatter, lines } = make({ includeSpec: IncludeSpec.parse("tools:in:100") });

        formatter.format(subagentUser("Task"));
        formatter.format(subagentUser([toolResult("hidden result")]));
        formatter.format(
            subagentAssistant([
                { type: "thinking", thinking: "hidden thought" },
                text("hidden text"),
                toolUse("Grep", { pattern: "x" }),
            ])
        );

        expect(lines).toEqual([]);
    });
});

describe("ClaudeSessionFormatter output", () => {
    const target: TailTarget = {
        filePath: "/tmp/fixture/abc.jsonl",
        label: "Invoice session",
        sessionId: "abc",
        isAgent: false,
    };

    it("prints a plain banner describing the target and the options", () => {
        const { formatter, lines } = make();

        formatter.printBanner({ target, includeSpec: IncludeSpec.defaults(), follow: true, stopOnFinish: false });

        expect(lines).toEqual([
            `┌ claude tail ── [session] Invoice session ${"─".repeat(20)}`,
            `│ Including: ${IncludeSpec.defaults().describe()}`,
            "│ Following: yes  Stop on finish: no",
            "│ Source: /tmp/fixture/abc.jsonl",
            `└${"─".repeat(60)}`,
            "",
        ]);
    });

    it("names an agent by its description in a colored banner", () => {
        const { formatter, lines } = make({ colors: true });

        formatter.printBanner({
            target: { ...target, isAgent: true, agentDescription: "Explore billing" },
            includeSpec: IncludeSpec.parse("thinking"),
            follow: false,
            stopOnFinish: true,
        });

        expect(plain(lines)).toEqual([
            `┌ claude tail ── [agent] Explore billing ${"─".repeat(20)}`,
            "│ Including: thinking",
            "│ Following: no  Stop on finish: yes",
            "│ Source: /tmp/fixture/abc.jsonl",
            `└${"─".repeat(60)}`,
            "",
        ]);
    });

    it("writes ANSI-free lines to the output file and finishes the open agent section on close", async () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-formatter-"));
        const file = join(dir, "tail.log");

        try {
            const { formatter } = make({ outputFile: file, colors: true });

            formatter.format(user("question"));
            formatter.format(subagentUser("Task"));
            await formatter.close();

            const written = readFileSync(file, "utf-8").split("\n");

            expect(written[0]).toBe("❯ question");
            expect(written.some((line) => closingLine(line))).toBe(true);
            expect(written.at(-1)).toBe("");
            expect(written.join("\n")).not.toContain("\u001b[");
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("resolves close at once when there is no output file", async () => {
        const { formatter } = make();

        await expect(formatter.close()).resolves.toBeUndefined();
    });

    it("prints to the CLI output unless cliOutput is false and no output callback is set", () => {
        const println = spyOn(out, "println").mockImplementation(() => undefined);

        try {
            new ClaudeSessionFormatter({ includeSpec: IncludeSpec.defaults(), colors: false }).format(
                user("to the console")
            );
            new ClaudeSessionFormatter({ includeSpec: IncludeSpec.defaults(), colors: false, cliOutput: false }).format(
                user("silent")
            );

            expect(println.mock.calls).toEqual([["❯ to the console"]]);
        } finally {
            println.mockRestore();
        }
    });
});

function closingLine(line: string): boolean {
    return /^ {2}└─+ ✓ done( \(\d+ms\))? ─$/.test(line);
}
