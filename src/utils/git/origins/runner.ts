import { Executor } from "@genesiscz/utils/cli";
import { logger } from "@genesiscz/utils/logger";
import type { CommandRunner } from "./types";

/**
 * Default runner: a captured spawn with a timeout. A missing binary, a
 * timeout or a non-zero exit all come back as a result, never as a throw,
 * because a driver failure must degrade to "no corroboration", not abort
 * the caller.
 */
export const spawnRunner: CommandRunner = async (cmd, { cwd, timeoutMs }) => {
    try {
        const res = await new Executor({ cwd }).exec(cmd, { timeout: timeoutMs });
        return { code: res.exitCode, stdout: res.stdout, stderr: res.stderr };
    } catch (err) {
        logger.debug({ err, cmd }, "origins: command failed to run");
        return { code: 127, stdout: "", stderr: err instanceof Error ? err.message : String(err) };
    }
};

export const DRIVER_TIMEOUT_MS = 15_000;
