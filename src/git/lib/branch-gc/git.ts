export interface GitResult {
    stdout: string;
    stderr: string;
    code: number;
}

/**
 * Thin git runner. Shells out via `Bun.spawn(["git", "-C", cwd, ...args])`,
 * decoding stdout/stderr. No logging — callers decide what to do with the result.
 * `env` is merged over the inherited environment (e.g. to sandbox object writes).
 */
export async function runGit(cwd: string, args: string[], env?: Record<string, string>): Promise<GitResult> {
    const proc = Bun.spawn(["git", "-C", cwd, ...args], {
        stdout: "pipe",
        stderr: "pipe",
        env: env ? { ...process.env, ...env } : undefined,
    });

    const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
    ]);

    return { stdout, stderr, code };
}

/** Convenience for boolean predicate git commands (e.g. `--is-ancestor`). */
export async function gitOk(cwd: string, args: string[]): Promise<boolean> {
    const { code } = await runGit(cwd, args);
    return code === 0;
}
