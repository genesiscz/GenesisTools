import { createWriteStream, type WriteStream } from "node:fs";
import { formatDateTime } from "@app/utils/date";
import { SafeJSON } from "@app/utils/json";
import pc from "picocolors";
import type { IncludeSpec } from "./cli/dsl";
import type { TailTarget } from "./session.types";
import { agentProgressToSubagent, parseAgentCompletionStats } from "./session.utils";
import type {
    AssistantMessage,
    AssistantMessageContent,
    ConversationMessage,
    ProgressMessage,
    SubagentMessage,
    TextBlock,
    ToolResultBlock,
    ToolUseBlock,
    UserMessage,
} from "./types";

/** Shorthand "A" variant that some JSONL sessions use for assistant messages. */
interface ShorthandAssistant {
    type: "A";
    message?: AssistantMessageContent;
    timestamp?: string;
}

interface FormatterOptions {
    includeSpec: IncludeSpec;
    colors: boolean;
    outputFile?: string;
    cliOutput?: boolean;
    raw?: boolean;
}

const AGENT_COLORS = [pc.cyan, pc.magenta, pc.yellow, pc.green, pc.blue] as const;

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape codes are the target
const ANSI_REGEX = /\x1B\[\d+m/g;

function stripAnsi(text: string): string {
    return text.replace(ANSI_REGEX, "");
}

function formatTime(timestamp: string): string {
    try {
        return formatDateTime(timestamp, { absolute: "time-seconds" });
    } catch {
        return "??:??:??";
    }
}

function truncate(text: string, maxChars: number): string {
    if (maxChars <= 0) {
        return "";
    }

    if (text.length <= maxChars) {
        return text;
    }

    return `${text.slice(0, maxChars)}...`;
}

function extractToolInputSummary(tool: ToolUseBlock): string {
    const input = tool.input;

    if ("command" in input && typeof input.command === "string") {
        return input.command;
    }

    if ("file_path" in input && typeof input.file_path === "string") {
        return input.file_path;
    }

    if ("pattern" in input && typeof input.pattern === "string") {
        return input.pattern;
    }

    if ("query" in input && typeof input.query === "string") {
        return input.query;
    }

    if ("skill" in input && typeof input.skill === "string") {
        return input.skill;
    }

    const safeInput = SafeJSON.stringify(input);
    return safeInput;
}

function extractToolResultText(block: ToolResultBlock): string {
    if (typeof block.content === "string") {
        return block.content;
    }

    if (Array.isArray(block.content)) {
        return block.content
            .filter((b): b is TextBlock => b.type === "text")
            .map((b) => b.text)
            .join("\n");
    }

    return "";
}

/**
 * Formats JSONL records into colorized terminal output.
 * Handles agent bordered sections, content truncation, and dual output.
 */
export class ClaudeSessionFormatter {
    private agentColorMap = new Map<string, (typeof AGENT_COLORS)[number]>();
    private nextColorIndex = 0;
    private activeAgentId: string | null = null;
    private agentStartTime = new Map<string, number>();
    private fileStream: WriteStream | null = null;

    constructor(private options: FormatterOptions) {
        if (options.outputFile) {
            this.fileStream = createWriteStream(options.outputFile, { flags: "a" });
        }
    }

    format(record: ConversationMessage): void {
        if (this.options.raw) {
            this.writeLine(SafeJSON.stringify(record, null, 0));
            return;
        }

        // Auto-close agent section when parent conversation resumes.
        // Hook progress can interleave within agent sequences — don't close on those.
        if (this.activeAgentId && record.type !== "progress" && record.type !== "subagent") {
            this.closeAgentSection();
        }

        const timestamp = "timestamp" in record && typeof record.timestamp === "string" ? record.timestamp : "";

        switch (record.type) {
            case "user":
                this.formatUserMessage(record, timestamp);
                break;
            case "assistant":
                this.formatAssistantMessage(record, timestamp);
                break;
            case "subagent":
                this.formatSubagentMessage(record, timestamp);
                break;
            case "system":
                break;
            case "progress": {
                const converted = agentProgressToSubagent(record as ProgressMessage);

                if (converted) {
                    this.formatSubagentMessage(converted, timestamp);
                }

                break;
            }
            case "custom-title":
                break;
            case "summary":
                break;
            default: {
                const raw = record as unknown as ShorthandAssistant;

                if (raw.type === "A" && raw.message) {
                    this.formatAssistantMessage(
                        { type: "assistant", message: raw.message } as AssistantMessage,
                        raw.timestamp ?? timestamp
                    );
                }

                break;
            }
        }
    }

    closeAgentSection(): void {
        if (this.activeAgentId) {
            const startTime = this.agentStartTime.get(this.activeAgentId);
            const duration = startTime ? this.formatDuration(Date.now() - startTime) : "";
            const colorFn = this.getAgentColor(this.activeAgentId);
            const suffix = duration ? ` done (${duration})` : " done";
            this.writeLine(
                colorFn(`  \u2514${"─".repeat(40)}${"─".repeat(Math.max(0, 20 - suffix.length))} \u2713${suffix} ─`)
            );
            this.activeAgentId = null;
        }
    }

    printBanner(options: {
        target: TailTarget;
        includeSpec: IncludeSpec;
        follow: boolean;
        stopOnFinish: boolean;
    }): void {
        const { target, includeSpec, follow, stopOnFinish } = options;
        const c = this.options.colors;

        const typeLabel = target.isAgent ? "agent" : "session";
        const nameLabel = target.agentDescription || target.label;

        const header = c
            ? `${pc.bold(pc.cyan("┌ claude tail"))} ── ${pc.bold(`[${typeLabel}]`)} ${pc.bold(pc.green(nameLabel))} ${"─".repeat(20)}`
            : `┌ claude tail ── [${typeLabel}] ${nameLabel} ${"─".repeat(20)}`;

        this.writeLine(header);
        this.writeLine(
            c ? `${pc.cyan("│")} Including: ${includeSpec.describe()}` : `│ Including: ${includeSpec.describe()}`
        );
        this.writeLine(
            c
                ? `${pc.cyan("│")} Following: ${follow ? "yes" : "no"}  Stop on finish: ${stopOnFinish ? "yes" : "no"}`
                : `│ Following: ${follow ? "yes" : "no"}  Stop on finish: ${stopOnFinish ? "yes" : "no"}`
        );
        this.writeLine(c ? `${pc.cyan("│")} Source: ${target.filePath}` : `│ Source: ${target.filePath}`);
        this.writeLine(c ? `${pc.cyan("└")}${"─".repeat(60)}` : `└${"─".repeat(60)}`);
        this.writeLine("");
    }

    close(): Promise<void> {
        this.closeAgentSection();

        if (!this.fileStream) {
            return Promise.resolve();
        }

        return new Promise((resolve) => {
            this.fileStream!.end(() => {
                this.fileStream = null;
                resolve();
            });
        });
    }

    private formatUserMessage(msg: UserMessage, timestamp: string): void {
        const content = msg.message.content;
        let text: string;

        if (typeof content === "string") {
            text = content;
        } else {
            const textParts: string[] = [];

            for (const block of content) {
                if (block.type === "text") {
                    textParts.push(block.text);
                }
            }

            text = textParts.join("\n");

            for (const block of content) {
                if (block.type !== "tool_result") {
                    continue;
                }

                const result = extractToolResultText(block);

                if (!result) {
                    continue;
                }

                // Show agent completion stats from Agent tool_result
                const agentStats = parseAgentCompletionStats(result);

                if (agentStats && this.options.includeSpec.shouldShow("agents:result")) {
                    const dur = this.formatDuration(agentStats.durationMs);
                    const line = `  ⏱ Agent ${agentStats.agentId.slice(0, 8)}: ${dur}, ${agentStats.toolUses} tools, ${agentStats.totalTokens.toLocaleString()} tokens`;
                    this.writeLine(this.options.colors ? pc.dim(line) : line);
                    continue;
                }

                if (this.options.includeSpec.shouldShow("tools:out")) {
                    const maxChars = this.options.includeSpec.truncationLength("tools:out");
                    const isError = block.is_error;
                    const truncated = truncate(result.trim(), maxChars);
                    const prefix = isError ? "  ✗ " : "  → ";
                    const line = `${prefix}${truncated}`;
                    const formatted = this.options.colors ? (isError ? pc.red(line) : pc.dim(line)) : line;
                    this.writeLine(formatted);
                }
            }
        }

        if (!text.trim()) {
            return;
        }

        // Skip meta/internal user messages
        if (msg.isMeta) {
            return;
        }

        const time = formatTime(timestamp);
        const firstLine = text.trim().split("\n")[0];

        if (this.options.colors) {
            this.writeLine(`${pc.dim(time)} ${pc.bold(pc.green("You:"))} ${firstLine}`);
        } else {
            this.writeLine(`${time} You: ${firstLine}`);
        }
    }

    private formatAssistantMessage(msg: AssistantMessage, timestamp: string): void {
        const blocks = msg.message?.content;

        if (!Array.isArray(blocks)) {
            return;
        }

        const time = formatTime(timestamp);
        let hasTextOutput = false;

        for (const block of blocks) {
            if (block.type === "thinking" && this.options.includeSpec.shouldShow("thinking")) {
                const thinking = block.thinking.trim();

                if (thinking) {
                    const firstLine = thinking.split("\n")[0];
                    const formatted = this.options.colors
                        ? pc.dim(`${time} 💭 ${firstLine}`)
                        : `${time} [thinking] ${firstLine}`;
                    this.writeLine(formatted);
                }
            }

            if (block.type === "text") {
                const text = block.text.trim();

                if (text) {
                    hasTextOutput = true;
                    const firstLine = text.split("\n")[0];

                    if (this.options.colors) {
                        this.writeLine(`${pc.dim(time)} ${pc.bold(pc.blue("Claude:"))} ${firstLine}`);
                    } else {
                        this.writeLine(`${time} Claude: ${firstLine}`);
                    }

                    for (const line of text.split("\n").slice(1)) {
                        if (line.trim()) {
                            this.writeLine(`         ${line}`);
                        }
                    }
                }
            }

            if (block.type === "tool_use" && this.options.includeSpec.shouldShow("tools:in")) {
                const inputSummary = extractToolInputSummary(block);
                const maxChars = this.options.includeSpec.truncationLength("tools:in");
                const truncated = truncate(inputSummary, maxChars);

                if (this.options.colors) {
                    this.writeLine(
                        `${pc.dim(hasTextOutput ? "        " : time)}   ${pc.dim(`[${block.name}]`)} ${pc.dim(truncated)}`
                    );
                } else {
                    this.writeLine(`${hasTextOutput ? "        " : time}   [${block.name}] ${truncated}`);
                }
            }
        }
    }

    private formatSubagentMessage(msg: SubagentMessage, timestamp: string): void {
        const agentId = msg.agentId || "unknown";
        const time = formatTime(timestamp);
        const message = msg.message;

        if (message.role === "user") {
            const content = message.content;

            if (typeof content !== "string" && this.options.includeSpec.shouldShow("agents:tools:out")) {
                for (const block of content) {
                    if (block.type === "tool_result") {
                        const result = extractToolResultText(block);
                        const maxChars = this.options.includeSpec.truncationLength("agents:tools:out");
                        const isError = block.is_error;

                        if (result) {
                            const truncated = truncate(result.trim(), maxChars);
                            const colorFn = this.getAgentColor(agentId);
                            const prefix = this.activeAgentId === agentId ? colorFn("  │ ") : "    ";
                            const marker = isError ? "  ✗ " : "  → ";
                            const line = `${prefix}${marker}${truncated}`;
                            const formatted = this.options.colors ? (isError ? pc.red(line) : pc.dim(line)) : line;
                            this.writeLine(formatted);
                        }
                    }
                }
            }

            if (!this.options.includeSpec.shouldShow("agents:input")) {
                return;
            }

            let text = "";

            if (typeof content === "string") {
                text = content;
            } else {
                text = content
                    .filter((b): b is TextBlock => b.type === "text")
                    .map((b) => b.text)
                    .join("\n");
            }

            if (!text.trim()) {
                return;
            }

            this.openAgentSection(agentId, text.trim().split("\n")[0], timestamp);
            return;
        }

        const assistantContent = message.content;

        if (!Array.isArray(assistantContent)) {
            return;
        }

        const colorFn = this.getAgentColor(agentId);
        const prefix = this.activeAgentId === agentId ? colorFn("  │ ") : "    ";

        for (const block of assistantContent) {
            if (block.type === "thinking" && this.options.includeSpec.shouldShow("agents:thinking")) {
                const thinking = block.thinking.trim();

                if (thinking) {
                    const firstLine = thinking.split("\n")[0];
                    this.writeLine(
                        `${prefix}${this.options.colors ? pc.dim(`${time} 💭 ${firstLine}`) : `${time} [thinking] ${firstLine}`}`
                    );
                }
            }

            if (block.type === "text") {
                if (!this.options.includeSpec.shouldShow("agents:result")) {
                    continue;
                }

                const text = block.text.trim();

                if (text) {
                    const firstLine = text.split("\n")[0];

                    if (this.options.colors) {
                        this.writeLine(`${prefix}${pc.dim(time)} ${pc.bold(pc.blue("Claude:"))} ${firstLine}`);
                    } else {
                        this.writeLine(`${prefix}${time} Claude: ${firstLine}`);
                    }
                }
            }

            if (block.type === "tool_use" && this.options.includeSpec.shouldShow("agents:tools:in")) {
                const inputSummary = extractToolInputSummary(block);
                const maxChars = this.options.includeSpec.truncationLength("agents:tools:in");
                const truncated = truncate(inputSummary, maxChars);

                if (this.options.colors) {
                    this.writeLine(`${prefix}${pc.dim(`  [${block.name}]`)} ${pc.dim(truncated)}`);
                } else {
                    this.writeLine(`${prefix}  [${block.name}] ${truncated}`);
                }
            }
        }

        const stopReason = message.stop_reason;

        if (stopReason === "end_turn" && this.activeAgentId === agentId) {
            this.closeAgentSection();
        }
    }

    private openAgentSection(agentId: string, description: string, timestamp: string): void {
        if (this.activeAgentId && this.activeAgentId !== agentId) {
            this.closeAgentSection();
        }

        const colorFn = this.getAgentColor(agentId);
        this.activeAgentId = agentId;
        this.agentStartTime.set(agentId, Date.now());

        const time = formatTime(timestamp);
        this.writeLine("");
        this.writeLine(
            `${this.options.colors ? pc.dim(time) : time}   ${this.options.colors ? pc.bold("[Agent]") : "[Agent]"} ${description}`
        );
        this.writeLine(colorFn(`  ┌─ Agent: ${description} ${"─".repeat(Math.max(1, 50 - description.length))}`));
    }

    private getAgentColor(agentId: string): (typeof AGENT_COLORS)[number] {
        let color = this.agentColorMap.get(agentId);

        if (!color) {
            color = AGENT_COLORS[this.nextColorIndex % AGENT_COLORS.length];
            this.agentColorMap.set(agentId, color);
            this.nextColorIndex++;
        }

        return color;
    }

    private formatDuration(ms: number): string {
        if (ms < 1000) {
            return `${ms}ms`;
        }

        const seconds = Math.floor(ms / 1000);

        if (seconds < 60) {
            return `${seconds}s`;
        }

        const minutes = Math.floor(seconds / 60);
        const remainingSeconds = seconds % 60;
        return `${minutes}m ${remainingSeconds}s`;
    }

    private writeLine(line: string): void {
        if (this.options.cliOutput !== false) {
            console.log(line);
        }

        if (this.fileStream) {
            this.fileStream.write(`${stripAnsi(line)}\n`);
        }
    }
}
