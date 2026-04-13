import { formatDateTime } from "@app/utils/date";
import pc from "picocolors";
import type { FormattedBlock } from "../formatters/types";

// ─── Types ────────────────────────────────────────────────────────────────

export interface TerminalRenderOptions {
    colors: boolean;
    indent?: string;
    compact?: boolean;
}

// ─── Tool category colors ─────────────────────────────────────────────────

type Colorizer = (s: string) => string;

const TOOL_CATEGORY: Record<string, Colorizer> = {
    Read: pc.cyan,
    Grep: pc.cyan,
    Glob: pc.cyan,
    Edit: pc.yellow,
    Write: pc.yellow,
    MultiEdit: pc.yellow,
    Bash: pc.magenta,
    Agent: pc.green,
};

// ─── Renderer ─────────────────────────────────────────────────────────────

export class TerminalRenderer {
    private readonly indent: string;

    constructor(private options: TerminalRenderOptions) {
        this.indent = options.indent ?? "";
    }

    render(blocks: FormattedBlock[]): string[] {
        const lines: string[] = [];

        for (const block of blocks) {
            lines.push(...this.renderBlock(block));
        }

        return lines;
    }

    renderBlock(block: FormattedBlock): string[] {
        switch (block.type) {
            case "role-header":
                return this.renderRoleHeader(block);

            case "text":
                return this.renderText(block);

            case "thinking":
                return this.renderThinking(block);

            case "tool-signature":
                return this.renderToolSignature(block);

            case "tool-diff":
                return this.renderToolDiff(block);

            case "tool-result":
                return this.renderToolResult(block);

            case "agent-notification":
                return this.renderAgentNotification(block);

            case "separator":
                return [""];

            case "image":
                return [this.line(this.dim(`[image: ${block.meta?.language ?? "unknown"}]`))];

            case "metadata":
                return [this.line(this.dim(block.content))];

            case "code":
                return this.renderCode(block);
        }
    }

    // ─── Block renderers ──────────────────────────────────────────────────

    private renderRoleHeader(block: FormattedBlock): string[] {
        const isUser = block.meta?.role === "user";
        const label = isUser ? `› You` : `⏺ Claude`;
        const styled = isUser ? this.color(pc.bold, pc.green, label) : this.color(pc.bold, pc.blue, label);

        let header = styled;

        if (block.meta?.timestamp) {
            const time = formatDateTime(block.meta.timestamp, { absolute: "time" });
            header += ` ${this.dim(time)}`;
        }

        return [this.line(header)];
    }

    private renderText(block: FormattedBlock): string[] {
        const textLines = block.lines ?? block.content.split("\n");
        const isUser = block.meta?.role === "user";

        return textLines.map((l) => this.line(isUser ? this.colorFn(pc.green, l) : l));
    }

    private renderThinking(block: FormattedBlock): string[] {
        const textLines = block.lines ?? block.content.split("\n");

        return textLines.map((l) => this.line(this.color(pc.dim, pc.italic, l)));
    }

    private renderToolSignature(block: FormattedBlock): string[] {
        return [this.line(this.colorizeSignature(block))];
    }

    private renderToolDiff(block: FormattedBlock): string[] {
        const diffLines = block.lines ?? block.content.split("\n");

        return diffLines.map((l) => {
            let styled: string;

            if (l.startsWith("+")) {
                styled = this.colorFn(pc.green, l);
            } else if (l.startsWith("-")) {
                styled = this.colorFn(pc.red, l);
            } else {
                styled = this.dim(l);
            }

            return this.line(`  ${styled}`);
        });
    }

    private renderToolResult(block: FormattedBlock): string[] {
        const resultLines = block.lines ?? block.content.split("\n");
        const isError = block.meta?.isError ?? false;

        return resultLines.map((l) => {
            const styled = isError ? this.colorFn(pc.red, l) : this.dim(l);
            return this.line(`  ${styled}`);
        });
    }

    private renderAgentNotification(block: FormattedBlock): string[] {
        const status = block.meta?.status ?? "running";
        const icon = status === "completed" ? "✓" : "…";
        const agentId = block.meta?.agentId ?? "unknown";
        const shortId = agentId.length > 8 ? agentId.slice(0, 8) : agentId;
        const text = `${icon} Agent ${shortId}: ${block.content}`;

        return [this.line(this.dim(text))];
    }

    private renderCode(block: FormattedBlock): string[] {
        const codeLines = block.lines ?? block.content.split("\n");

        return codeLines.map((l) => this.line(l));
    }

    // ─── Signature colorizer ──────────────────────────────────────────────

    private colorizeSignature(block: FormattedBlock): string {
        const toolName = block.meta?.toolName ?? "";
        const content = block.content;

        if (!this.options.colors) {
            return content;
        }

        const parenIdx = content.indexOf("(");

        if (parenIdx === -1) {
            return this.applyToolColor(toolName, content);
        }

        const name = content.slice(0, parenIdx);
        const args = content.slice(parenIdx);
        const coloredName = this.applyToolColor(toolName, name);

        return `${coloredName}${pc.dim(args)}`;
    }

    private applyToolColor(toolName: string, text: string): string {
        const colorize = TOOL_CATEGORY[toolName];

        if (colorize) {
            return colorize(text);
        }

        return pc.dim(text);
    }

    // ─── Styling helpers ──────────────────────────────────────────────────

    private line(content: string): string {
        return `${this.indent}${content}`;
    }

    private dim(text: string): string {
        if (!this.options.colors) {
            return text;
        }

        return pc.dim(text);
    }

    private colorFn(fn: (s: string) => string, text: string): string {
        if (!this.options.colors) {
            return text;
        }

        return fn(text);
    }

    private color(...fns: [...((s: string) => string)[], string]): string {
        const text = fns.pop() as string;

        if (!this.options.colors) {
            return text;
        }

        let result = text;

        for (let i = fns.length - 1; i >= 0; i--) {
            result = (fns[i] as (s: string) => string)(result);
        }

        return result;
    }
}
