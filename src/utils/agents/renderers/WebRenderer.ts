import type { FormattedBlock } from "../formatters/types";

export class WebRenderer {
    render(blocks: FormattedBlock[]): string {
        return blocks.map((b) => this.renderBlock(b)).join("\n");
    }

    renderBlock(block: FormattedBlock): string {
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
                return `<hr class="msg-separator" />`;
            case "image":
                return `<div class="msg-image">[image: ${this.escape(block.content)}]</div>`;
            case "metadata":
                return `<div class="msg-metadata">${this.escape(block.content)}</div>`;
            case "code":
                return this.renderCode(block);
        }
    }

    private renderRoleHeader(block: FormattedBlock): string {
        const role = block.meta?.role ?? "assistant";
        return `<div class="role-header role-${role}">${this.escape(block.content)}</div>`;
    }

    private renderText(block: FormattedBlock): string {
        const role = block.meta?.role ?? "assistant";
        const html = this.escape(block.content).replace(/\n/g, "<br>");
        return `<div class="msg-text msg-${role}">${html}</div>`;
    }

    private renderThinking(block: FormattedBlock): string {
        return (
            `<details class="thinking-block">` +
            `<summary>Thinking</summary>` +
            `<pre>${this.escape(block.content)}</pre>` +
            `</details>`
        );
    }

    private renderToolSignature(block: FormattedBlock): string {
        const toolName = block.meta?.toolName ?? "";
        return `<div class="tool-signature" data-tool="${this.escape(toolName)}">${this.escape(block.content)}</div>`;
    }

    private renderToolDiff(block: FormattedBlock): string {
        const lines = block.lines ?? block.content.split("\n");
        const inner = lines
            .map((line) => {
                const cls = this.diffLineClass(line);
                return `<span class="${cls}">${this.escape(line)}</span>`;
            })
            .join("\n");

        return `<pre class="tool-diff">${inner}</pre>`;
    }

    private renderToolResult(block: FormattedBlock): string {
        const errorCls = block.meta?.isError ? " error" : "";
        return `<pre class="tool-result${errorCls}">${this.escape(block.content)}</pre>`;
    }

    private renderAgentNotification(block: FormattedBlock): string {
        const status = block.meta?.status ?? "unknown";
        const agentId = block.meta?.agentId ?? "";
        const shortId = agentId.slice(0, 8);
        return (
            `<div class="agent-notification status-${this.escape(status)}">` +
            `<span class="agent-id">${this.escape(shortId)}</span> ` +
            `${this.escape(block.content)}` +
            `</div>`
        );
    }

    private renderCode(block: FormattedBlock): string {
        const lang = block.meta?.language ?? "";
        const langCls = lang ? ` class="language-${this.escape(lang)}"` : "";
        return `<pre class="code-block"><code${langCls}>${this.escape(block.content)}</code></pre>`;
    }

    private diffLineClass(line: string): string {
        if (line.startsWith("+")) {
            return "diff-add";
        }

        if (line.startsWith("-")) {
            return "diff-remove";
        }

        return "diff-context";
    }

    private escape(s: string): string {
        return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    }
}
