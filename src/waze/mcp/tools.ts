import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { logger } from "@genesiscz/utils/logger";
import type { CallToolResult, Tool } from "@modelcontextprotocol/server";
import { z } from "zod";
import { WazeContext, type WazeContextOptions } from "../lib/context";
import { runDoctor } from "../lib/doctor";
import { WAZE_OPERATIONS, type WazeOperation } from "../lib/operations";

/**
 * Every Waze MCP tool, ready to mount on any MCP server. `tools waze mcp` serves this list; the genesis-tools MCP
 * mounts the same list through `createWazeToolset`, prefixed `waze_`.
 */

export const WAZE_MCP_INSTRUCTIONS =
    "Live Waze reports (unofficial; read from the Waze live map in the user's own Brave over CDP, one background tab). " +
    "Trips: police (police with km markers), route (ETA, alternatives, every report and jam on the corridor), depart " +
    "(best departure time), export (GeoJSON/GPX/KML/CSV). Areas: alerts, jams, near. Places: geocode, venues, venue, " +
    'link (official deep links, no browser). History: record, history, hotspots. Places accept a name or "lat,lon". ' +
    `If a tool reports no browser, the user starts it with ${toolCommand("chrome-devtools restart", "--browser", "brave", "--port", "9222")}; ` +
    `diagnose with doctor or ${toolCommand("waze doctor")}.`;

export interface WazeMcpTool {
    name: string;
    description: string;
    inputSchema: Tool["inputSchema"];
    annotations: Tool["annotations"];
    call(args: unknown): Promise<CallToolResult>;
}

function errorMessage(error: unknown): string {
    if (error instanceof z.ZodError) {
        return z.prettifyError(error);
    }

    return error instanceof Error ? error.message : String(error);
}

function toolFrom(ctx: WazeContext, op: WazeOperation): WazeMcpTool {
    const writes = op.name === "record";
    return {
        name: op.name,
        description: op.description,
        inputSchema: z.toJSONSchema(op.input, { io: "input" }) as Tool["inputSchema"],
        annotations: {
            readOnlyHint: !writes,
            destructiveHint: false,
            idempotentHint: !writes,
            openWorldHint: op.usesBrowser,
        },
        call: async (args) => {
            const started = performance.now();
            try {
                const result = await op.run(ctx, args ?? {});
                logger.debug({ tool: op.name, ms: Math.round(performance.now() - started) }, "waze mcp tool");
                return {
                    content: [{ type: "text", text: result.markdown }],
                    structuredContent: { result: result.data },
                };
            } catch (error) {
                logger.warn({ error, tool: op.name }, "waze mcp tool failed");
                return { isError: true, content: [{ type: "text", text: `Error: ${errorMessage(error)}` }] };
            }
        },
    };
}

function doctorTool(port: number | undefined): WazeMcpTool {
    return {
        name: "doctor",
        description: "Read-only health check: browser CDP port, the live-map tab, one token mint and one georss call.",
        inputSchema: { type: "object", properties: {} },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
        call: async () => {
            const checks = await runDoctor({ port });
            const text = checks
                .map(
                    (check) =>
                        `- ${check.status.toUpperCase()} ${check.name}: ${check.detail}${check.fix ? ` (fix: ${check.fix})` : ""}`
                )
                .join("\n");
            return { content: [{ type: "text", text }], structuredContent: { result: checks } };
        },
    };
}

export interface WazeToolset {
    tools: WazeMcpTool[];
    instructions: string;
    close(): Promise<void>;
}

/** One context for the whole server: the tab opens on the first Waze call and closes on close(). */
export function createWazeToolset(opts: WazeContextOptions = {}): WazeToolset {
    const ctx = new WazeContext(opts);
    return {
        tools: [...WAZE_OPERATIONS.map((op) => toolFrom(ctx, op)), doctorTool(opts.port)],
        instructions: WAZE_MCP_INSTRUCTIONS,
        close: () => ctx.close(),
    };
}
