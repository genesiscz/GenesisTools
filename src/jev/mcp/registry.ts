import type { z } from "zod";

/**
 * One read-only Jev tool exposed over MCP.
 *
 * The registry exists so the later live-policy packages can add `jev_compact` and `jev_verify`
 * without touching the server file: they call `registry.add(...)` from their own module and the
 * transport wiring stays in one place.
 */
export interface JevMcpTool {
    name: string;
    description: string;
    inputSchema: z.ZodType;
    /** False only for a tool that changes durable state; every Jev tool today is read-only. */
    readOnly: boolean;
    run(input: unknown, context: { signal?: AbortSignal }): Promise<unknown>;
}

export class JevMcpRegistry {
    private readonly tools = new Map<string, JevMcpTool>();

    add(tool: JevMcpTool): this {
        if (this.tools.has(tool.name)) {
            throw new Error(`Jev MCP tool "${tool.name}" is already registered.`);
        }

        this.tools.set(tool.name, tool);
        return this;
    }

    get(name: string): JevMcpTool | undefined {
        return this.tools.get(name);
    }

    list(): JevMcpTool[] {
        return [...this.tools.values()];
    }

    get size(): number {
        return this.tools.size;
    }
}
