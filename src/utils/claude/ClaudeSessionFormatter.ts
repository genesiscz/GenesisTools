import { createWriteStream, type WriteStream } from "node:fs";
import { formatToolDiff, formatToolSignature } from "@app/utils/agents/formatters/tool-formatter";
import { formatDateTime } from "@app/utils/date";
import { SafeJSON } from "@app/utils/json";
import { stripAnsi, truncateText } from "@app/utils/string";
import pc from "picocolors";
import type { IncludeSpec } from "./cli/dsl";
import type { TailTarget } from "./session.types";
import { agentProgressToSubagent, parseAgentCompletionStats } from "./session.utils";
import { extractToolResultText } from "./session-helpers";
import { renderMarkdown } from "./terminal-markdown";
import type {
    AssistantMessage,
    AssistantMessageContent,
    ContentBlock,
    ConversationMessage,
    ProgressMessage,
    SubagentMessage,
    TextBlock,
    UserMessage,
} from "./types";

/** Shorthand "A" variant that some JSONL sessions use for assistant messages. */
interface ShorthandAssistant {
    type: "A";
    message?: AssistantMessageContent;
    timestamp?: string;
}

interface TaskNotification {
    taskId: string;
    status: string;
    summary: string;
}

function parseTaskNotification(text: string): TaskNotification | null {
    if (!text.includes("<task-notification>")) {
        return null;
    }

    const taskId = text.match(/<task-id>([^<]+)<\/task-id>/)?.[1] ?? "unknown";
    const status = text.match(/<status>([^<]+)<\/status>/)?.[1] ?? "unknown";
    const summary = text.match(/<summary>([^<]+)<\/summary>/)?.[1] ?? "agent task";

    return { taskId, status, summary };
}

interface FormatterOptions {
    includeSpec: IncludeSpec;
    colors: boolean;
    outputFile?: string;
    cliOutput?: boolean;
    raw?: boolean;
    /** "full" = current behavior, "mini" = condensed for list views. Default: "full" */
    mode?: "full" | "mini";
    /** Show box borders around agent sections. Default: true in full, false in mini */
    border?: boolean;
    /** Use actor icons instead of "You:"/"Claude:". Default: false in full, true in mini */
    actorIcons?: boolean;
    /** Max chars per message text in mini mode. Default: 200 */
    maxCharsPerMessage?: number;
    /** Prefix string for each output line. Default: "" */
    indent?: string;
    /** Custom output callback — when set, writeLine calls this instead of console.log */
    output?: (line: string) => void;
    /** Show timestamps. Default: true in full, false in mini */
    timestamps?: boolean;
}

const AGENT_COLORS = [pc.cyan, pc.magenta, pc.yellow, pc.green, pc.blue] as const;

function formatTime(timestamp: string): string {
    try {
        return formatDateTime(timestamp, { absolute: "time-seconds" });
    } catch {
        return "??:??:??";
    }
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

    private get isMini(): boolean {
        return this.options.mode === "mini";
    }

    private get showBorder(): boolean {
        return this.options.border ?? !this.isMini;
    }

    private get showActorIcons(): boolean {
        return this.options.actorIcons ?? this.isMini;
    }

    private get showTimestamps(): boolean {
        return this.options.timestamps ?? !this.isMini;
    }

    private get maxChars(): number {
        return this.options.maxCharsPerMessage ?? (this.isMini ? 200 : Infinity);
    }

    private get lineIndent(): string {
        return this.options.indent ?? "";
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
        if (!this.activeAgentId) {
            return;
        }

        if (!this.showBorder) {
            this.activeAgentId = null;
            return;
        }

        const startTime = this.agentStartTime.get(this.activeAgentId);
        const duration = startTime ? this.formatDuration(Date.now() - startTime) : "";
        const colorFn = this.getAgentColor(this.activeAgentId);
        const suffix = duration ? ` done (${duration})` : " done";
        this.writeLine(colorFn(`  └${"─".repeat(40)}${"─".repeat(Math.max(0, 20 - suffix.length))} ✓${suffix} ─`));
        this.activeAgentId = null;
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

            if (!this.isMini) {
                for (const block of content) {
                    if (block.type !== "tool_result") {
                        continue;
                    }

                    const result = extractToolResultText(block);

                    if (!result) {
                        continue;
                    }

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
                        const truncated = truncateText(result.trim(), maxChars);
                        const line = `  ⎿ ${truncated}`;
                        const formatted = this.options.colors ? (isError ? pc.red(line) : pc.dim(line)) : line;
                        this.writeLine(formatted);
                    }
                }
            }
        }

        if (!text.trim()) {
            return;
        }

        if (msg.isMeta) {
            return;
        }

        // Format task-notification XML as a clean one-liner
        const taskNotif = parseTaskNotification(text);

        if (taskNotif) {
            const statusIcon = taskNotif.status === "completed" ? "✓" : "…";
            const line = `  ${statusIcon} Agent ${taskNotif.taskId.slice(0, 8)}: ${taskNotif.summary}`;
            this.writeLine(this.options.colors ? pc.dim(line) : line);
            return;
        }

        // Strip system-reminder blocks — internal noise, not user content
        text = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();

        if (!text) {
            return;
        }

        if (this.isMini) {
            const collapsed = text.trim().replace(/\n+/g, " ");
            const truncated = truncateText(collapsed, this.maxChars);
            const icon = this.showActorIcons ? "🧑 " : "";
            this.writeLine(this.options.colors ? `${icon}${pc.green(truncated)}` : `${icon}${truncated}`);
            return;
        }

        const time = this.showTimestamps ? formatTime(timestamp) : "";
        const rendered = this.options.colors ? renderMarkdown(text.trim()) : text.trim();
        const lines = rendered.split("\n");
        const firstLine = lines[0];
        const pad = this.showTimestamps ? "         " : "  ";

        if (this.options.colors) {
            this.writeLine(
                time
                    ? `${pc.dim(time)} ${pc.bold(pc.green("❯"))} ${firstLine}`
                    : `${pc.bold(pc.green("❯"))} ${firstLine}`
            );
        } else {
            this.writeLine(time ? `${time} ❯ ${firstLine}` : `❯ ${firstLine}`);
        }

        for (const line of lines.slice(1)) {
            this.writeLine(`${pad}${line}`);
        }
    }

    private formatAssistantMessage(msg: AssistantMessage, timestamp: string): void {
        const blocks = msg.message?.content;

        if (!Array.isArray(blocks)) {
            return;
        }

        if (this.isMini) {
            this.formatAssistantMini(blocks);
            return;
        }

        const time = this.showTimestamps ? formatTime(timestamp) : "";
        const pad = this.showTimestamps ? "         " : "  ";
        let hasTextOutput = false;

        for (const block of blocks) {
            if (block.type === "thinking" && this.options.includeSpec.shouldShow("thinking")) {
                const thinking = block.thinking.trim();

                if (thinking) {
                    const firstLine = thinking.split("\n")[0];
                    const formatted = this.options.colors
                        ? pc.dim(time ? `${time} ∴ ${firstLine}` : `∴ ${firstLine}`)
                        : `${time ? `${time} ` : ""}∴ ${firstLine}`;
                    this.writeLine(formatted);
                }
            }

            if (block.type === "text") {
                const raw = block.text.trim();

                if (raw) {
                    hasTextOutput = true;
                    const rendered = this.options.colors ? renderMarkdown(raw) : raw;
                    const lines = rendered.split("\n");
                    const firstLine = lines[0];

                    if (this.options.colors) {
                        this.writeLine(
                            time ? `${pc.dim(time)} ${pc.blue("⏺")} ${firstLine}` : `${pc.blue("⏺")} ${firstLine}`
                        );
                    } else {
                        this.writeLine(time ? `${time} ⏺ ${firstLine}` : `⏺ ${firstLine}`);
                    }

                    for (const line of lines.slice(1)) {
                        this.writeLine(line ? `${pad}${line}` : "");
                    }
                }
            }

            if (block.type === "tool_use" && this.options.includeSpec.shouldShow("tools:in")) {
                const maxChars = this.options.includeSpec.truncationLength("tools:in");
                const signature = formatToolSignature(block.name, (block.input ?? {}) as Record<string, unknown>, {
                    primaryMaxChars: maxChars,
                    detailLevel: "summary",
                });
                const timePrefix = hasTextOutput ? pad.slice(0, -1) : time;

                if (this.options.colors) {
                    this.writeLine(`${pc.dim(timePrefix)} ${this.colorizeSignature(block.name, signature)}`);
                } else {
                    this.writeLine(`${timePrefix} ⏺ ${signature}`);
                }

                const diffLines =
                    maxChars > 500
                        ? formatToolDiff(block.name, (block.input ?? {}) as Record<string, unknown>, maxChars)
                        : null;

                if (diffLines) {
                    for (const line of diffLines) {
                        if (this.options.colors) {
                            const colored = line.startsWith("+")
                                ? pc.green(line)
                                : line.startsWith("-")
                                  ? pc.red(line)
                                  : pc.dim(line);
                            this.writeLine(`${pad} ${colored}`);
                        } else {
                            this.writeLine(`${pad} ${line}`);
                        }
                    }
                }
            }
        }
    }

    private formatAssistantMini(blocks: ContentBlock[]): void {
        const textParts: string[] = [];
        const toolSummaries: string[] = [];

        for (const block of blocks) {
            if (block.type === "text" && block.text.trim()) {
                textParts.push(block.text.trim());
            }

            if (block.type === "tool_use" && this.options.includeSpec.shouldShow("tools:in")) {
                const maxLen = this.options.includeSpec.truncationLength("tools:in");
                const signature = formatToolSignature(block.name, (block.input ?? {}) as Record<string, unknown>, {
                    primaryMaxChars: maxLen,
                    detailLevel: "summary",
                });

                if (this.options.colors) {
                    toolSummaries.push(this.colorizeSignature(block.name, signature));
                } else {
                    toolSummaries.push(signature);
                }
            }
        }

        if (textParts.length > 0) {
            const collapsed = textParts.join(" ").replace(/\n+/g, " ");
            const truncated = truncateText(collapsed, this.maxChars);
            const icon = this.showActorIcons ? "🤖 " : "";
            this.writeLine(this.options.colors ? `${icon}${pc.blue(truncated)}` : `${icon}${truncated}`);
        }

        for (const tool of toolSummaries) {
            const padding = this.showActorIcons ? "   " : "  ";
            this.writeLine(`${padding}◆ ${tool}`);
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
                            const truncated = truncateText(result.trim(), maxChars);
                            const prefix = this.agentLinePrefix(agentId);
                            const line = `${prefix}  ⎿ ${truncated}`;
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

        const prefix = this.agentLinePrefix(agentId);

        for (const block of assistantContent) {
            if (block.type === "thinking" && this.options.includeSpec.shouldShow("agents:thinking")) {
                const thinking = block.thinking.trim();

                if (thinking) {
                    const firstLine = thinking.split("\n")[0];
                    this.writeLine(
                        `${prefix}${this.options.colors ? pc.dim(`${time} ∴ ${firstLine}`) : `${time} ∴ ${firstLine}`}`
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
                        this.writeLine(`${prefix}${pc.dim(time)} ${pc.blue("⏺")} ${firstLine}`);
                    } else {
                        this.writeLine(`${prefix}${time} ⏺ ${firstLine}`);
                    }
                }
            }

            if (block.type === "tool_use" && this.options.includeSpec.shouldShow("agents:tools:in")) {
                const maxChars = this.options.includeSpec.truncationLength("agents:tools:in");
                const signature = formatToolSignature(block.name, (block.input ?? {}) as Record<string, unknown>, {
                    primaryMaxChars: maxChars,
                    detailLevel: "summary",
                });

                if (this.options.colors) {
                    this.writeLine(`${prefix}  ${this.colorizeSignature(block.name, signature)}`);
                } else {
                    this.writeLine(`${prefix}  ⏺ ${signature}`);
                }

                const diffLines =
                    maxChars > 500
                        ? formatToolDiff(block.name, (block.input ?? {}) as Record<string, unknown>, maxChars)
                        : null;

                if (diffLines) {
                    for (const line of diffLines) {
                        if (this.options.colors) {
                            const colored = line.startsWith("+")
                                ? pc.green(line)
                                : line.startsWith("-")
                                  ? pc.red(line)
                                  : pc.dim(line);
                            this.writeLine(`${prefix}    ${colored}`);
                        } else {
                            this.writeLine(`${prefix}    ${line}`);
                        }
                    }
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

        if (!this.showBorder) {
            const padding = this.showActorIcons ? "   " : "  ";
            const desc = truncateText(description, this.maxChars);
            const line = `${padding}◆ Agent → "${desc}"`;
            this.writeLine(this.options.colors ? colorFn(line) : line);
            return;
        }

        const time = formatTime(timestamp);
        const shortDesc = truncateText(description, 80);

        this.writeLine("");
        this.writeLine(
            this.options.colors
                ? `${pc.dim(time)} ${pc.green(`⏺ Agent(${shortDesc})`)}`
                : `${time} ⏺ Agent(${shortDesc})`
        );
        this.writeLine(colorFn(`  ┌─ ${shortDesc} ${"─".repeat(Math.max(1, 50 - shortDesc.length))}`));
    }

    private agentLinePrefix(agentId: string): string {
        if (!this.showBorder) {
            return this.showActorIcons ? "   " : "    ";
        }

        const colorFn = this.getAgentColor(agentId);
        return this.activeAgentId === agentId ? colorFn("  │ ") : "    ";
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

    private colorizeToolLabel(name: string): string {
        switch (name) {
            case "Read":
            case "Glob":
            case "Grep":
                return pc.cyan(name);
            case "Edit":
            case "Write":
                return pc.yellow(name);
            case "Bash":
                return pc.magenta(name);
            case "Agent":
                return pc.green(name);
            default:
                return pc.dim(name);
        }
    }

    private colorizeSignature(name: string, signature: string): string {
        const parenIdx = signature.indexOf("(");

        if (parenIdx === -1) {
            return `⏺ ${this.colorizeToolLabel(name)}`;
        }

        const args = signature.slice(parenIdx);
        return `${pc.blue("⏺")} ${this.colorizeToolLabel(name)}${pc.dim(args)}`;
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
        const indented = this.lineIndent ? `${this.lineIndent}${line}` : line;

        if (this.options.output) {
            this.options.output(indented);
        } else if (this.options.cliOutput !== false) {
            console.log(indented);
        }

        if (this.fileStream) {
            this.fileStream.write(`${stripAnsi(indented)}\n`);
        }
    }
}
