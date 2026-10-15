// Runs the C core's `--index` walk as a subprocess and parses its NDJSON rows.
// A subprocess for the same reason as `--bigfiles` (engine.ts listBigFiles): the
// event loop stays free for progress and SIGINT, and the C side's globals and
// `exit(1)` on allocation failure cannot take the Bun process down.

import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { profiler } from "@genesiscz/utils/profile";
import { ensureBinary } from "../engine";

const log = logger.child({ component: "du:index:walk" });
const prof = profiler.scope("du.engine");

/** One stored directory (`t:"d"`), or the region root's walked totals (`t:"r"`). */
export interface WalkNode {
    /** Node id in this walk; a parent's id is below its children's. */
    i: number;
    /** Parent node id, -1 for the walk root. */
    p: number;
    /** Basename; the walk root carries its absolute path. */
    n: string;
    f: number;
    a: number;
    l: number;
    v: number;
    c: number;
    d: number;
    x: number;
    m: number;
    dm: number;
    fl: number;
}

export interface WalkBig {
    /** The stored node that owns the file (its folder, or the nearest stored ancestor). */
    o: number;
    p: string;
    l: number;
    a: number;
    f: number;
    m: number;
    n: number;
}

export interface WalkEnd {
    files: number;
    dirs: number;
    stored: number;
    folded: number;
    big: number;
    big_total: number;
    denied: number;
    vanished: number;
    errors: number;
    walk_ms: number;
    threads: number;
    /** Worker threads started, replacements for given-up folders included. */
    workers: number;
    private: number;
    /** Folders given up by the stall watchdog (no progress for `stallSeconds`). */
    blocked: number;
    root_errno: number;
    fsid: string;
}

export interface WalkProgress {
    files: number;
    dirs: number;
    bytes: number;
    elapsed_ms: number;
    dir: string;
}

export interface WalkBlocked {
    path: string;
    waited_ms: number;
}

export interface WalkOptions {
    root: string;
    threads?: number;
    minDirBytes: number;
    bigFileFloor: number;
    bigFileLimit: number;
    private: boolean;
    excludes: string[];
    includeCloud: boolean;
    /** Region walk for `update`: a file of "fileid<TAB>path" lines naming children not to enter. */
    keepFile?: string;
    /** Give up a folder whose listing makes no progress for this long (C default 10; 0 = never). */
    stallSeconds?: number;
    /** Extra environment for the walker (tests use CLONESIZE_TEST_BLOCK_DIR). */
    env?: Record<string, string>;
    /** One call per folder the watchdog gave up, while the walk goes on. */
    onBlocked?: (b: WalkBlocked) => void;
    signal?: AbortSignal;
    onProgress?: (p: WalkProgress) => void;
}

export interface WalkOutput {
    nodes: WalkNode[];
    /** Region walks only: the region root's totals over what was walked. */
    region: WalkNode | null;
    big: WalkBig[];
    /** Region walks only: names of the region root's children that were not entered. */
    kept: string[];
    end: WalkEnd;
    exitCode: number;
}

export function walkArgs(opts: WalkOptions): string[] {
    const args = [
        "--index",
        "--min-dir-bytes",
        String(Math.max(0, Math.floor(opts.minDirBytes))),
        "--big-file-floor",
        String(Math.max(0, Math.floor(opts.bigFileFloor))),
        "--big-file-limit",
        String(Math.max(0, Math.floor(opts.bigFileLimit))),
    ];
    if (opts.threads && opts.threads > 0) {
        args.push("--threads", String(opts.threads));
    }

    if (!opts.private) {
        args.push("--no-private");
    }

    if (opts.includeCloud) {
        args.push("--include-cloud");
    }

    for (const ex of opts.excludes) {
        args.push("--exclude", ex);
    }

    if (opts.keepFile) {
        args.push("--region", "--keep-file", opts.keepFile);
    }

    if (opts.stallSeconds !== undefined) {
        args.push("--stall-seconds", String(opts.stallSeconds));
    }

    args.push(opts.root);
    return args;
}

/** Splits a byte stream into lines, decoding UTF-8 without throwing on a stray byte. */
async function forEachLine(stream: ReadableStream<Uint8Array>, onLine: (line: string) => void): Promise<void> {
    const decoder = new TextDecoder("utf-8", { fatal: false });
    let pending = "";
    for await (const chunk of stream) {
        pending += decoder.decode(chunk, { stream: true });
        let nl = pending.indexOf("\n");
        while (nl >= 0) {
            const line = pending.slice(0, nl);
            pending = pending.slice(nl + 1);
            if (line.length > 0) {
                onLine(line);
            }

            nl = pending.indexOf("\n");
        }
    }

    pending += decoder.decode();
    if (pending.length > 0) {
        onLine(pending);
    }
}

type WalkRow = ({ t: "d" | "r" } & WalkNode) | ({ t: "b" } & WalkBig) | { t: "k"; n: string } | ({ t: "e" } & WalkEnd);

/** Strict JSON.parse per row: comment-json (the tolerant SafeJSON path) once rejected a real file name. */
function parseRow(line: string): WalkRow {
    return SafeJSON.parse(line, { strict: true }) as WalkRow;
}

/**
 * Runs `clonesize --index` and collects its rows. Rejects with `signal.reason`
 * when aborted (the subprocess is killed), and with an Error naming the exit
 * code and the stderr tail when the walk fails. Exit 3 is not a failure here:
 * it means the root could not be read, and `end.root_errno` says why.
 */
export async function runIndexWalk(opts: WalkOptions): Promise<WalkOutput> {
    const bin = ensureBinary();
    const args = walkArgs(opts);
    opts.signal?.throwIfAborted();
    log.debug({ bin, args }, "running the index walk");
    const end = prof.start(opts.keepFile ? "c-subprocess.index-region" : "c-subprocess.index");
    const proc = Bun.spawn([bin, ...args], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        env: { ...env.getProcessEnv(), ...opts.env },
    });
    const onAbort = () => proc.kill();
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    const nodes: WalkNode[] = [];
    const big: WalkBig[] = [];
    const kept: string[] = [];
    // A holder, not two `let`s: TypeScript does not see assignments made inside the line callbacks.
    const last: { region: WalkNode | null; end: WalkEnd | null } = { region: null, end: null };
    const stderrTail: string[] = [];

    try {
        await Promise.all([
            forEachLine(proc.stdout, (line) => {
                const row = parseRow(line);
                if (row.t === "d") {
                    nodes.push(row);
                } else if (row.t === "b") {
                    big.push(row);
                } else if (row.t === "r") {
                    last.region = row;
                } else if (row.t === "k") {
                    kept.push(row.n);
                } else if (row.t === "e") {
                    last.end = row;
                } else {
                    log.warn({ line: line.slice(0, 200) }, "unknown index row");
                }
            }),
            forEachLine(proc.stderr, (line) => {
                if (line.startsWith('{"progress":true')) {
                    opts.onProgress?.(SafeJSON.parse(line, { strict: true }) as WalkProgress);
                    return;
                }

                if (line.startsWith('{"blocked":true')) {
                    const b = SafeJSON.parse(line, { strict: true }) as WalkBlocked;
                    log.warn(
                        { path: b.path, waitedMs: b.waited_ms },
                        "index walk gave up a folder that made no progress"
                    );
                    opts.onBlocked?.(b);
                    return;
                }

                log.debug({ line }, "index walk stderr");
                stderrTail.push(line);
                if (stderrTail.length > 5) {
                    stderrTail.shift();
                }
            }),
        ]);
        const code = await proc.exited;
        opts.signal?.throwIfAborted();
        if ((code !== 0 && code !== 3) || last.end === null) {
            throw new Error(`clonesize --index exited with ${code}: ${stderrTail.join(" | ") || "no output"}`);
        }

        return { nodes, region: last.region, big, kept, end: last.end, exitCode: code };
    } catch (err) {
        proc.kill();
        throw err;
    } finally {
        opts.signal?.removeEventListener("abort", onAbort);
        end();
    }
}
