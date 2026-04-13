import { formatToolResult, formatToolSignature } from "@app/utils/agents/formatters/tool-formatter";
import type { FormattedBlock } from "@app/utils/agents/formatters/types";
import { TerminalRenderer } from "@app/utils/agents/renderers/TerminalRenderer";
import type { ChatEvent } from "@ask/lib/ChatEvent";

export interface AskStreamRendererOptions {
    /** Write text deltas to this stream. Default: process.stdout */
    textStream?: NodeJS.WritableStream;
    /** Write tool call/result lines to this stream. Default: process.stderr */
    metaStream?: NodeJS.WritableStream;
    /** Enable color output. Default: true if metaStream is TTY */
    colors?: boolean;
    /** Max chars for tool input in signatures. Default: 200 */
    toolInputMaxChars?: number;
    /** Max chars for tool result content. Default: 300 */
    toolResultMaxChars?: number;
}

export class AskStreamRenderer {
    private readonly renderer: TerminalRenderer;
    private readonly textStream: NodeJS.WritableStream;
    private readonly metaStream: NodeJS.WritableStream;
    private readonly toolInputMaxChars: number;
    private readonly toolResultMaxChars: number;
    private needsNewlineBeforeMeta = false;

    constructor(options: AskStreamRendererOptions = {}) {
        this.textStream = options.textStream ?? process.stdout;
        this.metaStream = options.metaStream ?? process.stderr;
        this.toolInputMaxChars = options.toolInputMaxChars ?? 200;
        this.toolResultMaxChars = options.toolResultMaxChars ?? 300;

        const isTTY = "isTTY" in this.metaStream && (this.metaStream as NodeJS.WriteStream).isTTY;
        this.renderer = new TerminalRenderer({
            colors: options.colors ?? !!isTTY,
        });
    }

    /**
     * Render a ChatEvent to the appropriate stream.
     * Call this for each event from the ChatEvent async generator.
     */
    renderEvent(event: ChatEvent): void {
        if (event.isText()) {
            this.textStream.write(event.text);
            this.needsNewlineBeforeMeta = true;
            return;
        }

        if (event.isToolCall()) {
            this.renderToolCall(event.name, event.input);
            return;
        }

        if (event.isToolResult()) {
            this.renderToolResult(event.name, event.output);
            return;
        }

        if (event.isDone()) {
            this.ensureNewline();
        }
    }

    /**
     * Render a tool call (works with both streaming events and callback-based ChatEngine).
     */
    renderToolCall(name: string, args: unknown): void {
        this.ensureNewline();
        const toolInput = (args ?? {}) as Record<string, unknown>;
        const block: FormattedBlock = {
            type: "tool-signature",
            content: formatToolSignature(name, toolInput, {
                primaryMaxChars: this.toolInputMaxChars,
                detailLevel: "signature",
            }),
            meta: { toolName: name },
        };
        const lines = this.renderer.render([block]);
        this.metaStream.write(`${lines.join("\n")}\n`);
    }

    /**
     * Render a tool result (works with both streaming events and callback-based ChatEngine).
     */
    renderToolResult(name: string, result: unknown, isError?: boolean): void {
        const content = typeof result === "string" ? result : JSON.stringify(result);
        const formatted = formatToolResult(content, this.toolResultMaxChars, {
            isError: isError ?? false,
        });
        const block: FormattedBlock = {
            type: "tool-result",
            content: formatted,
            meta: { toolName: name, isError: isError ?? false },
        };
        const lines = this.renderer.render([block]);
        this.metaStream.write(`${lines.join("\n")}\n`);
    }

    private ensureNewline(): void {
        if (this.needsNewlineBeforeMeta) {
            this.textStream.write("\n");
            this.needsNewlineBeforeMeta = false;
        }
    }
}
