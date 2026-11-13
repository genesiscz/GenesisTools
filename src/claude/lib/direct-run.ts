import { type DirectRunDeps, runBinaryDirect } from "@app/ai/lib/embed/direct-run";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { isObject } from "@genesiscz/utils/object";

/**
 * How an embedding app's steer reaches claude. `now` (Claude Code's default) aborts the running step, so a steer
 * during a long command kills it (`Error calling tool (Bash): interrupt`, 2026-11-01). `next` waits for the next
 * tool boundary, like a message typed into the Claude Code CLI.
 */
export type SteerMode = "now" | "next";

export const STEER_ENV = "TOOLS_CLAUDE_EMBED_STEER";

/** `TOOLS_CLAUDE_EMBED_STEER=next` turns the rewrite on; anything else leaves the host's stdin untouched. */
export function steerModeFromEnv(): SteerMode {
    return env.get(STEER_ENV)?.trim() === "next" ? "next" : "now";
}

/**
 * One stdin line with a `priority: "now"` user message turned into `"next"`. Every other line, a line that does not
 * parse, and a line's newline come back byte for byte.
 */
export function rewriteSteerLine(line: string): string {
    if (!line.includes('"now"')) {
        return line;
    }

    const newline = line.endsWith("\r\n") ? "\r\n" : line.endsWith("\n") ? "\n" : "";
    const body = line.slice(0, line.length - newline.length);

    try {
        const message: unknown = SafeJSON.parse(body, { strict: true });

        if (
            typeof message === "object" &&
            message !== null &&
            !Array.isArray(message) &&
            "type" in message &&
            message.type === "user" &&
            "priority" in message &&
            message.priority === "now"
        ) {
            logger.info("[direct-run] steer priority now rewritten to next");
            return `${SafeJSON.stringify({ ...message, priority: "next" }, { strict: true })}${newline}`;
        }
    } catch (error) {
        logger.debug({ error }, "[direct-run] stdin line is not JSON; passed on unchanged");
    }

    return line;
}

/** Claude Code's synthetic root assistant frame for a rate-limited request (`error: "rate_limit"`). */
function isLimitAssistant(frame: Record<string, unknown>): boolean {
    return (
        frame.type === "assistant" &&
        frame.parent_tool_use_id === null &&
        frame.error === "rate_limit" &&
        isObject(frame.message) &&
        Array.isArray(frame.message.content)
    );
}

/** Claude Code's error result for a request the API refused with 429. */
function isLimitResult(frame: Record<string, unknown>): boolean {
    return (
        frame.type === "result" &&
        frame.is_error === true &&
        frame.api_error_status === 429 &&
        typeof frame.result === "string"
    );
}

function withNote(text: string, note: string): string {
    return `${text}\n\n${note}`;
}

/**
 * One stdout line of Claude Code with `note` appended to the text of its usage-limit frames: the synthetic assistant
 * message (the text T3 Code shows and hands a parent agent) and the error result. Every field the host classifies the
 * limit by (`rate_limit_event`, `error`, `api_error_params`, `api_error_status`) stays as Claude Code wrote it. Every
 * other line, a line that does not parse, and a line's newline come back byte for byte.
 */
export function annotateLimitLine(line: string, note: string): string {
    if (!line.includes('"rate_limit"') && !line.includes('"api_error_status":429')) {
        return line;
    }

    const newline = line.endsWith("\r\n") ? "\r\n" : line.endsWith("\n") ? "\n" : "";
    const body = line.slice(0, line.length - newline.length);

    try {
        const frame: unknown = SafeJSON.parse(body, { strict: true });

        if (!isObject(frame)) {
            return line;
        }

        if (isLimitAssistant(frame) && isObject(frame.message) && Array.isArray(frame.message.content)) {
            const content: unknown[] = frame.message.content;
            const lastText = content.findLastIndex((block) => isObject(block) && block.type === "text");
            const annotated =
                lastText === -1
                    ? [...content, { type: "text", text: note }]
                    : content.map((block, index) =>
                          index === lastText && isObject(block) && typeof block.text === "string"
                              ? { ...block, text: withNote(block.text, note) }
                              : block
                      );
            logger.info("[direct-run] usage-limit message annotated with the headroom note");
            return `${SafeJSON.stringify({ ...frame, message: { ...frame.message, content: annotated } }, { strict: true })}${newline}`;
        }

        if (isLimitResult(frame) && typeof frame.result === "string") {
            return `${SafeJSON.stringify({ ...frame, result: withNote(frame.result, note) }, { strict: true })}${newline}`;
        }
    } catch (error) {
        logger.debug({ error }, "[direct-run] stdout line is not JSON; passed on unchanged");
    }

    return line;
}

/**
 * Runs the real claude executable for an embedding app (`runBinaryDirect`): the user's `ccc`/`claude` wrappers add
 * `--dangerously-skip-permissions`, which would override the permission mode the app chose. With `steer: "next"`
 * the host's stdin goes through {@link rewriteSteerLine}.
 */
export function runClaudeBinaryDirect(
    input: {
        argv: string[];
        env: Record<string, string | undefined>;
        steer?: SteerMode;
        /** Rewrites claude's stdout line by line, e.g. {@link annotateLimitLine}. */
        stdoutLines?: (line: string) => string;
    },
    deps?: DirectRunDeps
): Promise<number> {
    const stdinLines = input.steer === "next" ? rewriteSteerLine : undefined;

    if (stdinLines) {
        logger.info("[direct-run] steer mode next: stdin goes through the priority rewrite");
    }

    return runBinaryDirect(
        {
            argv: input.argv,
            env: input.env,
            ...(stdinLines ? { stdinLines } : {}),
            ...(input.stdoutLines ? { stdoutLines: input.stdoutLines } : {}),
        },
        deps
    );
}
