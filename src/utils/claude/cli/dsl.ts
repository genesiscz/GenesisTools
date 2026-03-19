type TruncatableField = "toolsIn" | "toolsOut" | "agentsToolsIn" | "agentsToolsOut";
type ContentType =
    | "thinking"
    | "tools:in"
    | "tools:out"
    | "agents:input"
    | "agents:tools:in"
    | "agents:tools:out"
    | "agents:result"
    | "agents:thinking";

/**
 * Parses and queries the --include DSL for controlling tail output content.
 *
 * Syntax: comma-separated specifiers with colon-delimited hierarchy.
 * Numeric suffix sets truncation length.
 *
 * Examples:
 *   "thinking,tools:in:500,tools:out:500"
 *   "agents:input,agents:tools:in:50,agents:result"
 *   "thinking,tools,agents" (shorthand expansions)
 */
export class IncludeSpec {
    thinking: boolean;
    toolsIn: number | false;
    toolsOut: number | false;
    agentsInput: boolean;
    agentsToolsIn: number | false;
    agentsToolsOut: number | false;
    agentsResult: boolean;
    agentsThinking: boolean;

    static DEFAULT_SPEC =
        "thinking,tools:in:500,tools:out:500,agents:input,agents:tools:in:50,agents:tools:out:500,agents:result";

    constructor(spec?: string) {
        this.thinking = false;
        this.toolsIn = false;
        this.toolsOut = false;
        this.agentsInput = false;
        this.agentsToolsIn = false;
        this.agentsToolsOut = false;
        this.agentsResult = false;
        this.agentsThinking = false;

        if (spec !== undefined) {
            this.parseSpec(spec);
        }
    }

    static parse(spec: string): IncludeSpec {
        return new IncludeSpec(spec);
    }

    static defaults(): IncludeSpec {
        return new IncludeSpec(IncludeSpec.DEFAULT_SPEC);
    }

    /** When tailing an agent, agents:* maps to top-level equivalents */
    forAgent(): IncludeSpec {
        const result = new IncludeSpec();
        result.thinking = this.thinking || this.agentsThinking;
        result.toolsIn = this.toolsIn !== false ? this.toolsIn : this.agentsToolsIn;
        result.toolsOut = this.toolsOut !== false ? this.toolsOut : this.agentsToolsOut;
        result.agentsInput = this.agentsInput;
        result.agentsToolsIn = this.agentsToolsIn;
        result.agentsToolsOut = this.agentsToolsOut;
        result.agentsResult = this.agentsResult;
        result.agentsThinking = this.agentsThinking;
        return result;
    }

    /** Human-readable summary for startup banner */
    describe(): string {
        const parts: string[] = [];

        if (this.thinking) {
            parts.push("thinking");
        }

        const toolParts: string[] = [];

        if (this.toolsIn !== false) {
            toolParts.push(`in: ${this.toolsIn}`);
        }

        if (this.toolsOut !== false) {
            toolParts.push(`out: ${this.toolsOut}`);
        }

        if (toolParts.length > 0) {
            parts.push(`tools (${toolParts.join(", ")})`);
        }

        const agentParts: string[] = [];

        if (this.agentsInput) {
            agentParts.push("input");
        }

        const agentToolParts: string[] = [];

        if (this.agentsToolsIn !== false) {
            agentToolParts.push(`in: ${this.agentsToolsIn}`);
        }

        if (this.agentsToolsOut !== false) {
            agentToolParts.push(`out: ${this.agentsToolsOut}`);
        }

        if (agentToolParts.length > 0) {
            agentParts.push(`tools (${agentToolParts.join(", ")})`);
        }

        if (this.agentsResult) {
            agentParts.push("result");
        }

        if (this.agentsThinking) {
            agentParts.push("thinking");
        }

        if (agentParts.length > 0) {
            parts.push(`agents (${agentParts.join(", ")})`);
        }

        return parts.join(", ");
    }

    shouldShow(type: ContentType): boolean {
        switch (type) {
            case "thinking":
                return this.thinking;
            case "tools:in":
                return this.toolsIn !== false;
            case "tools:out":
                return this.toolsOut !== false;
            case "agents:input":
                return this.agentsInput;
            case "agents:tools:in":
                return this.agentsToolsIn !== false;
            case "agents:tools:out":
                return this.agentsToolsOut !== false;
            case "agents:result":
                return this.agentsResult;
            case "agents:thinking":
                return this.agentsThinking;
        }
    }

    truncationLength(type: "tools:in" | "tools:out" | "agents:tools:in" | "agents:tools:out"): number {
        const fieldMap: Record<string, TruncatableField> = {
            "tools:in": "toolsIn",
            "tools:out": "toolsOut",
            "agents:tools:in": "agentsToolsIn",
            "agents:tools:out": "agentsToolsOut",
        };

        const field = fieldMap[type];
        const value = this[field];
        return value === false ? 0 : value;
    }

    private parseSpec(spec: string): void {
        const parts = spec.split(",").map((s) => s.trim().toLowerCase());

        for (const part of parts) {
            if (!part) {
                continue;
            }

            if (part === "thinking") {
                this.thinking = true;
                continue;
            }

            if (part === "tools") {
                this.toolsIn = 500;
                this.toolsOut = 500;
                continue;
            }

            if (part.startsWith("tools:in")) {
                this.toolsIn = this.extractLimit(part, 500);
                continue;
            }

            if (part.startsWith("tools:out")) {
                this.toolsOut = this.extractLimit(part, 500);
                continue;
            }

            if (part === "agents") {
                this.agentsInput = true;
                this.agentsToolsIn = 50;
                this.agentsToolsOut = 500;
                this.agentsResult = true;
                continue;
            }

            if (part === "agents:input") {
                this.agentsInput = true;
                continue;
            }

            if (part === "agents:tools") {
                this.agentsToolsIn = 50;
                this.agentsToolsOut = 500;
                continue;
            }

            if (part.startsWith("agents:tools:in")) {
                this.agentsToolsIn = this.extractLimit(part, 50);
                continue;
            }

            if (part.startsWith("agents:tools:out")) {
                this.agentsToolsOut = this.extractLimit(part, 500);
                continue;
            }

            if (part === "agents:result") {
                this.agentsResult = true;
                continue;
            }

            if (part === "agents:thinking") {
                this.agentsThinking = true;
            }
        }
    }

    private extractLimit(part: string, defaultLimit: number): number {
        const segments = part.split(":");
        const lastSegment = segments[segments.length - 1];
        const parsed = Number.parseInt(lastSegment, 10);

        if (!Number.isNaN(parsed)) {
            return parsed;
        }

        return defaultLimit;
    }
}

export const INCLUDE_HELP = `
Include specifiers (comma-separated):
  thinking                Show thinking/reasoning blocks
  tools                   Shorthand: tools:in:500,tools:out:500
  tools:in[:<chars>]      Tool call inputs, truncated (default: 500)
  tools:out[:<chars>]     Tool call outputs, truncated (default: 500)
  agents                  Shorthand: agents:input,agents:tools,agents:result
  agents:input            Agent launch prompt
  agents:tools            Shorthand: agents:tools:in:50,agents:tools:out:500
  agents:tools:in[:<N>]   Agent tool inputs (default: 50)
  agents:tools:out[:<N>]  Agent tool outputs (default: 500)
  agents:result           Agent final response
  agents:thinking         Agent thinking blocks

Examples:
  --include thinking,tools,agents           Everything (with defaults)
  --include tools:in:200,agents:result      Tool inputs (200 chars) + agent results only
  --include thinking,tools:out:0            Thinking + tool inputs only (no outputs)
`.trim();
