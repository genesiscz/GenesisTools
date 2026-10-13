import { isZstdPath, readZstdFrames } from "./zstd";

export interface RipgrepRun {
    stdout: string;
    stderr: string;
    /** The worst exit code of the runs (rg exits 1 when nothing matched). */
    code: number;
    signal: string | null;
}

async function runOne({
    rg,
    args,
    timeoutMs,
    zst,
}: {
    rg: string;
    args: string[];
    timeoutMs?: number;
    zst?: string;
}): Promise<RipgrepRun> {
    const proc = Bun.spawn(zst ? [rg, ...args, "-"] : [rg, ...args], {
        stdin: zst ? "pipe" : "ignore",
        stdout: "pipe",
        stderr: "pipe",
        timeout: timeoutMs,
    });
    const output = Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);

    if (zst && proc.stdin) {
        try {
            for await (const frame of readZstdFrames(zst, { concurrency: 6 })) {
                proc.stdin.write(frame);
                await proc.stdin.flush();
            }
        } finally {
            await proc.stdin.end();
        }
    }

    const [[stdout, stderr], code] = await Promise.all([output, proc.exited]);
    return { stdout, stderr, code, signal: proc.signalCode ?? null };
}

/**
 * Runs ripgrep with `args` over files that may be plain or `.zst`: one rg over all the plain files (they stay
 * arguments, so rg maps them as before) and, at the same time, one rg per `.zst` file fed its decompressed frames on
 * stdin. Needs no `zstd` CLI (unlike `rg -z`). Use `--no-filename` in `args`: stdin has no file name. The outputs are
 * joined, plain files first.
 */
export async function ripgrepFiles({
    rg,
    args,
    files,
    timeoutMs,
}: {
    rg: string;
    args: string[];
    files: string[];
    timeoutMs?: number;
}): Promise<RipgrepRun> {
    const plain = files.filter((file) => !isZstdPath(file));
    const runs = await Promise.all([
        ...(plain.length > 0 ? [runOne({ rg, args: [...args, "--", ...plain], timeoutMs })] : []),
        ...files.filter(isZstdPath).map((zst) => runOne({ rg, args, timeoutMs, zst })),
    ]);

    const codes = runs.map((run) => run.code);
    const failed = Math.max(0, ...codes);

    return {
        stdout: runs.map((run) => run.stdout).join(""),
        stderr: runs.map((run) => run.stderr).join(""),
        // An error (2+) in any run wins; otherwise 0 when any run matched, 1 when none did.
        code: failed > 1 ? failed : Math.min(1, ...codes),
        signal: runs.find((run) => run.signal)?.signal ?? null,
    };
}
