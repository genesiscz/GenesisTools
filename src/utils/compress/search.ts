import { isZstdPath, readZstdFrames } from "./zstd";

/**
 * Frames decompressing ahead of the reader. On a 1 GB day log (2026-10-13): 1 ahead peaked at 83 MB RSS, 3 ahead at
 * 171 MB, with no gain in wall time once rg is the consumer.
 */
const FRAMES_AHEAD = 2;

/**
 * A `.zst` file's content as a pull stream: the next frame decompresses only when the consumer asks for more, so a
 * slow reader never makes frames queue up (a `FileSink.write` loop held 519 MB for a 3.5 GB week of logs).
 */
export function zstdContentStream(path: string, concurrency = FRAMES_AHEAD): ReadableStream<Uint8Array> {
    const frames = readZstdFrames(path, { concurrency });

    return new ReadableStream<Uint8Array>({
        async pull(controller) {
            const next = await frames.next();

            if (next.done) {
                controller.close();
            } else {
                controller.enqueue(next.value);
            }
        },
        async cancel() {
            await frames.return(undefined);
        },
    });
}

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
        stdin: zst ? zstdContentStream(zst) : "ignore",
        stdout: "pipe",
        stderr: "pipe",
        timeout: timeoutMs,
    });
    const output = Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);

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
    const compressed = files.filter(isZstdPath);
    // One compressed file at a time (beside the plain run): five in parallel peaked at 355 MB RSS for a week of logs.
    const zstRuns = (async () => {
        const results: RipgrepRun[] = [];

        for (const zst of compressed) {
            results.push(await runOne({ rg, args, timeoutMs, zst }));
        }

        return results;
    })();
    const runs = [
        ...(plain.length > 0 ? [await runOne({ rg, args: [...args, "--", ...plain], timeoutMs })] : []),
        ...(await zstRuns),
    ];

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
