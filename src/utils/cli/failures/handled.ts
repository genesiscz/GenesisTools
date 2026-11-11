import { randomUUID } from "node:crypto";
import { logger } from "@genesiscz/utils/logger";
import { stripAnsi } from "@genesiscz/utils/string";
import { currentTraceId } from "@genesiscz/utils/trace";
import { appendFailure, type FailureCaller, type ToolFailure } from "./record";
import { agentCaller, currentRunFacts, redactCurrentRunText, TOOLS_ROOT } from "./watch";

/** A handled MCP or REPL failure must be written before its response, rather than waiting for process exit. */
export function recordHandledFailure(options: {
    tool: string;
    call: string;
    error: unknown;
    durationMs?: number;
    dir?: string;
    caller?: FailureCaller | null;
}): ToolFailure | null {
    try {
        const run = currentRunFacts();
        const argv = run?.argv ?? [];
        const clean = (text: string) => redactCurrentRunText(stripAnsi(text));
        const error = options.error instanceof Error ? options.error : null;
        let caller = options.caller ?? null;
        if (options.caller === undefined) {
            try {
                caller = agentCaller();
            } catch (error) {
                logger.debug({ error }, "failures: no handled-call caller context");
            }
        }

        const message = clean(error?.message ?? String(options.error));
        const failure: ToolFailure = {
            v: 1,
            id: randomUUID(),
            at: new Date().toISOString(),
            kind: "error",
            tool: run?.tool ?? options.tool,
            command: run?.command ?? run?.tool ?? options.tool,
            argv,
            operation: { transport: "mcp", server: options.tool, name: options.call },
            exitCode: null,
            message: message.slice(0, 2000),
            errorName: error?.name ?? null,
            stack: error?.stack ? clean(error.stack).slice(0, 8000) : null,
            stderrTail: message.slice(-4000),
            fatal: false,
            durationMs: Math.max(0, Math.round(options.durationMs ?? 0)),
            pid: process.pid,
            ppid: process.ppid,
            cwd: process.cwd(),
            traceId: currentTraceId() ?? null,
            toolsRoot: TOOLS_ROOT,
            caller,
        };
        appendFailure(failure, options.dir);
        return failure;
    } catch (error) {
        logger.warn({ error, tool: options.tool, call: options.call }, "handled call failure could not be recorded");
        return null;
    }
}
