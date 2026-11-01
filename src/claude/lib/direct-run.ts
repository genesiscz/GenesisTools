import { type DirectRunDeps, runBinaryDirect } from "@app/ai/lib/embed/direct-run";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";

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

/**
 * Runs the real claude executable for an embedding app (`runBinaryDirect`): the user's `ccc`/`claude` wrappers add
 * `--dangerously-skip-permissions`, which would override the permission mode the app chose. With `steer: "next"`
 * the host's stdin goes through {@link rewriteSteerLine}.
 */
export function runClaudeBinaryDirect(
    input: { argv: string[]; env: Record<string, string | undefined>; steer?: SteerMode },
    deps?: DirectRunDeps
): Promise<number> {
    const stdinLines = input.steer === "next" ? rewriteSteerLine : undefined;

    if (stdinLines) {
        logger.info("[direct-run] steer mode next: stdin goes through the priority rewrite");
    }

    return runBinaryDirect({ argv: input.argv, env: input.env, ...(stdinLines ? { stdinLines } : {}) }, deps);
}
