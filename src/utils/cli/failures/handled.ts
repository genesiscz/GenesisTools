import { randomUUID } from "node:crypto";
import { logger } from "@genesiscz/utils/logger";
import { stripAnsi } from "@genesiscz/utils/string";
import { appendFailure, type FailureCaller, type ToolFailure } from "./record";
import {
    agentCaller,
    currentRunFacts,
    FAILURE_MESSAGE_CHARS,
    FAILURE_STACK_CHARS,
    FAILURE_TAIL_CHARS,
    processFailureFields,
    redactCurrentRunText,
} from "./watch";

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
            ...processFailureFields(new Date()),
            id: randomUUID(),
            kind: "error",
            tool: run?.tool ?? options.tool,
            command: run?.command ?? run?.tool ?? options.tool,
            argv,
            operation: { transport: "mcp", server: options.tool, name: options.call },
            exitCode: null,
            message: message.slice(0, FAILURE_MESSAGE_CHARS),
            errorName: error?.name ?? null,
            stack: error?.stack ? clean(error.stack).slice(0, FAILURE_STACK_CHARS) : null,
            stderrTail: message.slice(-FAILURE_TAIL_CHARS),
            fatal: false,
            durationMs: Math.max(0, Math.round(options.durationMs ?? 0)),
            caller,
        };
        appendFailure(failure, options.dir);
        return failure;
    } catch (error) {
        logger.warn({ error, tool: options.tool, call: options.call }, "handled call failure could not be recorded");
        return null;
    }
}
