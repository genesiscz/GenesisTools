import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { IndexerManager } from "../lib/manager";

export type McpTextResult = { content: Array<{ type: "text"; text: string }> };

/**
 * Register an MCP tool whose argument schema is a zod v4 raw shape.
 * Wraps the shape with z.object() for the v2 registerTool Standard Schema API.
 */
export function registerTool<Shape extends z.ZodRawShape>(
    server: McpServer,
    name: string,
    description: string,
    shape: Shape,
    handler: (args: z.infer<z.ZodObject<Shape>>) => Promise<McpTextResult>
): void {
    server.registerTool(
        name,
        {
            description,
            inputSchema: z.object(shape),
        },
        // Handler args are typed from our shape; SDK callback typing is looser.
        handler as (args: z.infer<z.ZodObject<Shape>>) => Promise<McpTextResult>
    );
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
