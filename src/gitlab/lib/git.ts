import { logger } from "@genesiscz/utils/logger";

export interface GitResult {
    stdout: string;
    stderr: string;
    exitCode: number;
}

/** Synchronous git in `cwd`; stdout is trimmed. The content check runs thousands of these, one after another. */
export function gitResult(cwd: string, args: string[]): GitResult {
    return runGit({ cwd, args, trim: true });
}

/**
 * `git show <rev>:<path>` with the file's text as stored: no trim, so a leading blank line keeps every
 * line number below it. Null when git cannot show it.
 */
export function gitShowFile(cwd: string, spec: string): string | null {
    const result = runGit({ cwd, args: ["show", spec], trim: false });

    return result.exitCode === 0 ? result.stdout : null;
}

function runGit(options: { cwd: string; args: string[]; trim: boolean }): GitResult {
    const { cwd, args } = options;

    try {
        const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
        const stdout = result.stdout.toString();

        return {
            stdout: options.trim ? stdout.trim() : stdout,
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
