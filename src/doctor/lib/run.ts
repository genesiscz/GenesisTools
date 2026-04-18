export interface RunResult {
    status: number;
    stdout: string;
    stderr: string;
    timedOut: boolean;
}

export interface RunOpts {
    timeoutMs?: number;
    cwd?: string;
    env?: Record<string, string>;
}

export async function run(cmd: string, args: string[] = [], opts: RunOpts = {}): Promise<RunResult> {
    let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;

    try {
        proc = Bun.spawn({
            cmd: [cmd, ...args],
            stdin: "ignore",
            stdout: "pipe",
            stderr: "pipe",
            cwd: opts.cwd,
            env: opts.env ? { ...process.env, ...opts.env } : undefined,
        });
    } catch {
        return { status: 127, stdout: "", stderr: "", timedOut: false };
    }

    let timedOut = false;
    const timer = opts.timeoutMs
        ? setTimeout(() => {
              timedOut = true;
              proc.kill();
          }, opts.timeoutMs)
        : null;

    const [stdout, stderr, status] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
    ]);

    if (timer) {
        clearTimeout(timer);
    }

    return { status, stdout, stderr, timedOut };
}

export async function runInherit(cmd: string, args: string[] = [], opts: RunOpts = {}): Promise<number> {
    try {
        const proc = Bun.spawn({
            cmd: [cmd, ...args],
            stdin: "inherit",
            stdout: "inherit",
            stderr: "inherit",
            cwd: opts.cwd,
            env: opts.env ? { ...process.env, ...opts.env } : undefined,
        });
        return await proc.exited;
    } catch {
        return 127;
    }
}

export async function isCommandAvailable(cmd: string): Promise<boolean> {
    const { status } = await run("which", [cmd]);
    return status === 0;
}
