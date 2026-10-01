import { collectOutput, execTool } from "@genesiscz/utils/cli";
import { env } from "@genesiscz/utils/env";
import { logger } from "@genesiscz/utils/logger";
import type { TransclusionRunner } from "./types";

const DEFAULT_RUN_TIMEOUT_MS = 10_000;
/** The most of each stream a token keeps; past it the child is stopped and the result says `truncated`. */
export const RUN_OUTPUT_CAP_BYTES = 5 * 1024 * 1024;

/**
 * The production runner: an argv spawn, never a shell, killed when the token's signal aborts or its
 * own timeout passes, and stopped once a stream passes `RUN_OUTPUT_CAP_BYTES`. `tools …` goes
 * through `execTool`, which resolves the checkout worktree-safely.
 */
export const defaultRunner: TransclusionRunner = async (argv, { cwd, signal, timeoutMs, env: extra }) => {
    if (signal.aborted) {
        return { code: 124, stdout: "", stderr: "aborted before start" };
    }

    const timeout = timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;

    if (argv[0] === "tools") {
        const result = await execTool(argv.slice(1), {
            cwd,
            timeout,
            env: extra,
            signal,
            maxOutputBytes: RUN_OUTPUT_CAP_BYTES,
        });
        return {
            code: result.timedOut ? 124 : result.exitCode,
            stdout: result.stdout,
            stderr: result.timedOut ? `timed out after ${timeout} ms` : result.stderr,
            ...(result.truncated ? { truncated: true } : {}),
        };
    }

    try {
        const proc = Bun.spawn(argv, {
            cwd,
            stdin: "ignore",
            stdout: "pipe",
            stderr: "pipe",
            env: { ...env.getProcessEnv(), ...extra },
        });
        const result = await collectOutput(proc, timeout, { signal, maxBytes: RUN_OUTPUT_CAP_BYTES });
        return {
            code: result.timedOut ? 124 : result.exitCode,
            stdout: result.stdout,
            stderr: result.timedOut ? `timed out after ${timeout} ms` : result.stderr,
            ...(result.truncated ? { truncated: true } : {}),
        };
    } catch (error) {
        logger.debug({ error, argv, cwd }, "transclude: command failed to start");
        return { code: 127, stdout: "", stderr: error instanceof Error ? error.message : String(error) };
    }
};
