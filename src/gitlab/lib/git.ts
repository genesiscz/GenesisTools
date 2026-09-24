import { logger } from "@genesiscz/utils/logger";

export interface GitResult {
    stdout: string;
    stderr: string;
    exitCode: number;
}

/** Synchronous git in `cwd`; stdout is trimmed. The content check runs thousands of these, one after another. */
export function gitResult(cwd: string, args: string[]): GitResult {
    try {
        const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });

        return {
            stdout: result.stdout.toString().trim(),
            stderr: result.stderr.toString().trim(),
            exitCode: result.exitCode ?? 1,
        };
    } catch (error) {
        logger.debug({ error, cwd, args }, "gitlab: git spawn failed");

        return { stdout: "", stderr: error instanceof Error ? error.message : String(error), exitCode: 1 };
    }
}

/** The top level of the checkout containing `cwd`, or `cwd` itself outside a repository. */
export function gitRepoRoot(cwd: string = process.cwd()): string {
    const result = gitResult(cwd, ["rev-parse", "--show-toplevel"]);

    return result.exitCode === 0 && result.stdout ? result.stdout : cwd;
}
