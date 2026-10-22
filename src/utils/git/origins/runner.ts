import { Executor } from "@genesiscz/utils/cli";
import { logger } from "@genesiscz/utils/logger";
import type { CommandRunner } from "./types";

/** The error for a host CLI that is not on this machine: the one cause behind every "exited 127". */
export function missingCliError(cli: string): string {
    return process.platform === "darwin" ? `${cli} is not installed (brew install ${cli})` : `${cli} is not installed`;
}

/**
 * Default runner: a captured spawn with a timeout. A missing binary, a
 * timeout or a non-zero exit all come back as a result, never as a throw,
 * because a driver failure must degrade to "no corroboration", not abort
 * the caller.
 */
export const spawnRunner: CommandRunner = async (cmd, { cwd, timeoutMs }) => {
    const [cli] = cmd;

    // Bun answers a binary that is not on PATH with exit 127 and no stderr, which the hub showed as
    // "gh exited 127" on a Mac that never had gh (2026-10-19). Name the cause before spawning.
    if (cli && !cli.includes("/") && Bun.which(cli) === null) {
        return { code: 127, stdout: "", stderr: missingCliError(cli) };
    }

    try {
        const res = await new Executor({ cwd }).exec(cmd, { timeout: timeoutMs });
        return { code: res.exitCode, stdout: res.stdout, stderr: res.stderr };
    } catch (err) {
        logger.debug({ err, cmd }, "origins: command failed to run");
        return { code: 127, stdout: "", stderr: err instanceof Error ? err.message : String(err) };
    }
};

export const DRIVER_TIMEOUT_MS = 15_000;
