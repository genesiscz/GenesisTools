import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { z } from "zod";
import { IndexerManager } from "../lib/manager";

export type McpTextResult = { content: Array<{ type: "text"; text: string }> };

/**
 * Register an MCP tool whose argument schema is a zod v4 raw shape.
 *
 * The MCP SDK resolves its own (nested) copy of zod for the `ZodRawShapeCompat`
 * type it exposes on `server.tool`. A shape built from our top-level zod v4 is
 * therefore not nominally assignable at that boundary even though it is
 * structurally identical and parses correctly at runtime (the SDK duck-types
 * v3/v4 schemas). This wrapper is the single place that reconciles the two zod
 * instances; every call site stays fully typed through `Shape`.
 */
export function registerTool<Shape extends z.ZodRawShape>(
    server: McpServer,
    name: string,
    description: string,
    shape: Shape,
    handler: (args: z.infer<z.ZodObject<Shape>>) => Promise<McpTextResult>
): void {
    const register = server.tool.bind(server) as (
        name: string,
        description: string,
        shape: Shape,
        handler: (args: z.infer<z.ZodObject<Shape>>) => Promise<McpTextResult>
    ) => void;
    register(name, description, shape, handler);
}

let manager: IndexerManager | null = null;
let managerPromise: Promise<IndexerManager> | null = null;

/** Lazy-init singleton IndexerManager. Reused across all tool handlers. */
export async function getManager(): Promise<IndexerManager> {
    if (manager) {
        return manager;
    }

    if (!managerPromise) {
        managerPromise = IndexerManager.load().then((m) => {
            manager = m;
            managerPromise = null;
            return m;
        });
    }

    return managerPromise;
}

/** Graceful shutdown: close all open indexers. */
export async function shutdownManager(): Promise<void> {
    if (manager) {
        await manager.close();
        manager = null;
    }
}

/** Format an error into a user-friendly MCP response string. */
export function formatError(action: string, err: unknown): string {
    const msg = err instanceof Error ? err.message : String(err);
    return `Error during ${action}: ${msg}`;
}
