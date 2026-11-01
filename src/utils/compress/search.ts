import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { type FileIdentity, FileIdentityCache, fileIdentity } from "@genesiscz/utils/fs/identity-cache";
import { storedFilePath } from "@genesiscz/utils/fs/read-lines";
import { logger } from "@genesiscz/utils/logger";
import { isZstdPath, readZstdFrames, ZSTD_SUFFIX } from "./zstd";

/**
 * Frames decompressing ahead of the reader. On a 1 GB day log (2026-10-13): 1 ahead peaked at 83 MB RSS, 3 ahead at
 * 171 MB, with no gain in wall time once rg is the consumer.
 */
const FRAMES_AHEAD = 2;

/**
 * A `.zst` file's content as a pull stream: the next frame decompresses only when the consumer asks for more, so a
 * slow reader never makes frames queue up (a `FileSink.write` loop held 519 MB for a 3.5 GB week of logs). A file that
 * does not open or decode errors the stream and goes to `onError`: a consumer such as rg sees only the end of its
 * input, so the error must reach the caller another way.
 */
export function zstdContentStream(
    path: string,
    { concurrency = FRAMES_AHEAD, onError }: { concurrency?: number; onError?: (err: Error) => void } = {}
): ReadableStream<Uint8Array> {
    const frames = readZstdFrames(path, { concurrency });

    return new ReadableStream<Uint8Array>({
        async pull(controller) {
            let next: IteratorResult<Uint8Array>;

            try {
                next = await frames.next();
            } catch (err) {
                const error = err instanceof Error ? err : new Error(String(err));
                onError?.(error);
                controller.error(error);
                return;
            }

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
    /** Empty when the caller took each line through `onLine`. */
    stdout: string;
    stderr: string;
    /** The worst exit code of the runs (rg exits 1 when nothing matched; 2 also when a `.zst` did not read). */
    code: number;
    signal: string | null;
}

/** Hands each line of `stream` to `onLine` as it arrives, so no more than one chunk of it is held at a time. */
async function eachLine(stream: ReadableStream<Uint8Array>, onLine: (line: string) => void): Promise<void> {
    const decoder = new TextDecoder();
    let rest = "";

    for await (const chunk of stream) {
        const lines = (rest + decoder.decode(chunk, { stream: true })).split("\n");
        rest = lines.pop() ?? "";
        for (const line of lines) {
            onLine(line);
        }
    }

    rest += decoder.decode();
    if (rest) {
        onLine(rest);
    }
}

async function runOne({
    rg,
    args,
    timeoutMs,
    zst,
    onLine,
}: {
    rg: string;
    args: string[];
    timeoutMs?: number;
    zst?: string;
    onLine?: (line: string) => void;
}): Promise<RipgrepRun> {
    // A `.zst` that stops reading ends rg's stdin like a finished file, so rg would answer "no match" (or a partial
    // count) with exit 0 or 1 and nothing on stderr. The failure is kept, rg is stopped, and the run reports exit 2
    // with the error, as rg itself does for a plain file it cannot read.
    let failure: Error | undefined;
    let stop = () => {};
    const stdin = zst
        ? zstdContentStream(zst, {
              onError: (err) => {
                  failure = err;
                  stop();
              },
          })
        : "ignore";
    const proc = Bun.spawn(zst ? [rg, ...args, "-"] : [rg, ...args], {
        stdin,
        stdout: "pipe",
        stderr: "pipe",
        timeout: timeoutMs,
    });
    stop = () => proc.kill();
    const output = Promise.all([
        onLine ? eachLine(proc.stdout, onLine).then(() => "") : new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
    ]);

    const [[stdout, stderr], code] = await Promise.all([output, proc.exited]);

    if (failure) {
        return { stdout, stderr: `${stderr}rg: ${zst}: ${failure.message}\n`, code: 2, signal: null };
    }

    return { stdout, stderr, code, signal: proc.signalCode ?? null };
}

/**
 * The plain files rg could not open because the daily pass retired each one after `storedFilePath` resolved it, so
 * its verified `.zst` holds it now (rg reports `rg: <file>: … (os error 2)`), and the run's stderr without their lines.
 */
function replacedDuringRun(stderr: string, plain: string[]): { replaced: string[]; stderr: string } {
    const replaced = new Set<string>();
    const kept: string[] = [];

    for (const line of stderr.split("\n")) {
        const file = line.endsWith("(os error 2)") ? plain.find((name) => line.startsWith(`rg: ${name}: `)) : undefined;

        if (file && existsSync(`${file}${ZSTD_SUFFIX}`)) {
            replaced.add(file);
        } else {
            kept.push(line);
        }
    }

    return { replaced: [...replaced], stderr: kept.join("\n") };
}

/**
 * Settles the run over the plain files when the daily pass retired some of them between `storedFilePath` and rg's open.
 * Each such file is searched as its `.zst` (rg read nothing of it, so no line comes twice) and its error leaves stderr.
 * When those were the only errors, the exit code is asked again with `-q` over the files that stayed: rg answers 2
 * for any error, so its code no longer says whether they matched. Returns the plain run, then the runs of the twins.
 */
async function searchReplacedTwins({
    run,
    plain,
    rg,
    args,
    timeoutMs,
    onLine,
}: {
    run: RipgrepRun;
    plain: string[];
    rg: string;
    args: string[];
    timeoutMs?: number;
    onLine?: (line: string) => void;
}): Promise<RipgrepRun[]> {
    if (run.signal || run.code < 2) {
        return [run];
    }

    const { replaced, stderr } = replacedDuringRun(run.stderr, plain);

    if (replaced.length === 0) {
        return [run];
    }

    logger.debug({ replaced }, "[compress] plain files were retired during the search; searching their .zst");
    let settled: RipgrepRun = { ...run, stderr };

    if (stderr.trim() === "") {
        const rest = plain.filter((file) => !replaced.includes(file));
        // `-q` stops at the first match and exits 0 for it; no output, so nothing reaches `onLine` twice.
        const quiet = rest.length > 0 ? await runOne({ rg, args: [...args, "-q", "--", ...rest], timeoutMs }) : null;
        settled = quiet
            ? { ...settled, code: quiet.code, stderr: quiet.stderr, signal: quiet.signal }
            : { ...settled, code: 1 };
    }

    const twins: RipgrepRun[] = [];

    for (const file of replaced) {
        twins.push(await runOne({ rg, args, timeoutMs, zst: `${file}${ZSTD_SUFFIX}`, onLine }));
    }

    return [settled, ...twins];
}

/**
 * Runs ripgrep with `args` over files that may be plain or `.zst`: one rg over all the plain files (they stay
 * arguments, so rg maps them as before) and, at the same time, one rg per `.zst` file fed its decompressed frames on
 * stdin. Needs no `zstd` CLI (unlike `rg -z`). Use `--no-filename` in `args`: stdin has no file name. The outputs are
 * joined, plain files first. With `onLine`, each output line goes there as it arrives (the runs interleave) and
 * `stdout` stays empty, so a caller that keeps only some lines never holds the whole output. A plain file the daily
 * pass replaces by its `.zst`, before the search or during it, is searched as the `.zst`.
 */
export async function ripgrepFiles({
    rg,
    args,
    files,
    timeoutMs,
    onLine,
}: {
    rg: string;
    args: string[];
    files: string[];
    timeoutMs?: number;
    onLine?: (line: string) => void;
}): Promise<RipgrepRun> {
    // A plain file the daily pass replaced since the caller listed it is searched as its `.zst`.
    const stored = files.map((file) => storedFilePath(file) ?? file);
    const plain = stored.filter((file) => !isZstdPath(file));
    const compressed = stored.filter(isZstdPath);
    // One compressed file at a time (beside the plain run): five in parallel peaked at 355 MB RSS for a week of logs.
    const zstRuns = (async () => {
        const results: RipgrepRun[] = [];

        for (const zst of compressed) {
            results.push(await runOne({ rg, args, timeoutMs, zst, onLine }));
        }

        return results;
    })();
    const plainRun = plain.length > 0 ? await runOne({ rg, args: [...args, "--", ...plain], timeoutMs, onLine }) : null;
    const zstResults = await zstRuns;
    const runs = [
        ...(plainRun ? await searchReplacedTwins({ run: plainRun, plain, rg, args, timeoutMs, onLine }) : []),
        ...zstResults,
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

/** Where a cached search keeps the lines it found in sealed files. */
export interface RipgrepDigest {
    /** Names the search: the file is `<dir>/<name>-<hash of the rg args>.json`, so a changed pattern starts empty. */
    name: string;
    /** The folder of the digest files, beside the files searched (`dayLogDigestsDir()` for the day logs). */
    dir: string;
    /** Whether a file is finished, so its lines may be kept: an earlier day's log, never today's. */
    sealed: (file: string) => boolean;
}

/** One pass over a week touches 7 day logs; the limit keeps months of them. */
const DIGEST_ENTRIES = 64;
const DIGEST_VERSION = 1;

function isLines(value: unknown): value is string[] {
    return Array.isArray(value) && value.every((line) => typeof line === "string");
}

/** The digest file of one search: a short hash of its arguments in the name. */
export function ripgrepDigestPath({ name, dir, args }: { name: string; dir: string; args: string[] }): string {
    const hash = createHash("sha256").update(args.join("\0")).digest("hex").slice(0, 8);
    return join(dir, `${name}-${hash}.json`);
}

/** Read from disk on every search (a few KB), so an entry the daily pass carried over is seen at once. */
function digestCache(path: string): FileIdentityCache<string[]> {
    return new FileIdentityCache<string[]>({
        limit: DIGEST_ENTRIES,
        persist: { path: () => path, version: DIGEST_VERSION, isValue: isLines },
    });
}

function outputLines(stdout: string): string[] {
    return stdout === "" ? [] : stdout.replace(/\n$/, "").split("\n");
}

/**
 * {@link ripgrepFiles} for a fixed search that runs again and again over the same finished files, such as the daemon's
 * health lines over a week of day logs. The lines rg found in a sealed file are kept on disk with the file's identity
 * (inode, size, mtime, ctime) and served while the file keeps it, so a finished day, plain or `.zst`, is searched once;
 * the daily pass carries the entry of a plain day over to its `.zst` (`carrySavedEntries`). Files that are not sealed
 * (today's log) are searched every time. Kept lines come after the searched ones, so order lines by their content.
 * `onLine` is not offered: the kept lines are what the caller reads.
 */
export async function ripgrepFilesCached({
    rg,
    args,
    files,
    timeoutMs,
    digest,
}: {
    rg: string;
    args: string[];
    files: string[];
    timeoutMs?: number;
    digest: RipgrepDigest;
}): Promise<RipgrepRun & { keptFiles: number }> {
    const cache = digestCache(ripgrepDigestPath({ name: digest.name, dir: digest.dir, args }));
    await cache.load();
    const kept: string[] = [];
    const searched: string[] = [];
    const toKeep: Array<{ file: string; identity: FileIdentity }> = [];
    let keptFiles = 0;

    for (const file of files) {
        // The identity is taken before the search, so a write during it leaves a newer identity and a miss next time.
        const identity = digest.sealed(file) ? fileIdentity(file) : null;
        const lines = identity ? cache.get(file, identity) : undefined;

        if (lines) {
            kept.push(...lines);
            keptFiles++;
        } else if (identity) {
            toKeep.push({ file, identity });
        } else {
            searched.push(file);
        }
    }

    // One sealed file per run, so its lines can be kept; they run one after another beside the open files' run, as a
    // `.zst` costs memory per run.
    const [open, sealed] = await Promise.all([
        searched.length > 0 ? ripgrepFiles({ rg, args, files: searched, timeoutMs }) : null,
        (async () => {
            const runs: RipgrepRun[] = [];

            for (const { file, identity } of toKeep) {
                const run = await ripgrepFiles({ rg, args, files: [file], timeoutMs });
                runs.push(run);

                if (!run.signal && run.code <= 1) {
                    cache.set(file, identity, outputLines(run.stdout));
                }
            }

            return runs;
        })(),
    ]);

    if (toKeep.length > 0) {
        await cache.save();
    }

    const runs = [...(open ? [open] : []), ...sealed];
    const codes = runs.map((run) => run.code);
    const failed = Math.max(0, ...codes);
    const matched = kept.length > 0 || codes.includes(0);
    logger.debug(
        { digest: digest.name, files: files.length, keptFiles, searched: searched.length + toKeep.length },
        "[compress] cached rg search"
    );

    return {
        stdout: runs.map((run) => run.stdout).join("") + kept.map((line) => `${line}\n`).join(""),
        stderr: runs.map((run) => run.stderr).join(""),
        code: failed > 1 ? failed : matched ? 0 : 1,
        signal: runs.find((run) => run.signal)?.signal ?? null,
        keptFiles,
    };
}
