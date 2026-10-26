import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { env } from "@genesiscz/utils/env";
import { removeRecursive } from "@genesiscz/utils/fs";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { boundedCommand } from "@genesiscz/utils/process/bounded-command";
import { toolDataDir } from "@genesiscz/utils/storage/root";
import { UsageError } from "../format";
import type {
    FilesResult,
    GraphResult,
    OwnResult,
    PhasesResult,
    ProgramMode,
    SitesResult,
    WorkerResult,
} from "./types";

const WORKER = join(import.meta.dir, "check-worker.ts");
export const DEFAULT_HEAP_MIB = 16_384;
/** A whole check of the GenesisTools root took 35-41 s (2026-10-25); a run past this is stuck, not slow. */
export const DEFAULT_TIMEOUT_MS = 15 * 60_000;
/** Room for a program with thousands of diagnostics on stdout (tsc) or a long stack on stderr. */
const OUTPUT_BUDGET_BYTES = 32 * 1024 * 1024;

export type ProgramRuntime = "node" | "bun";

export interface ProgramRunOptions {
    tsconfig: string;
    /** node (default): V8, the heap `tsc` and a reviewer's `ts.createProgram` use. bun: JavaScriptCore. */
    runtime?: ProgramRuntime;
    /**
     * The worker's heap limit in MiB (node only). A run that needs more fails as out of memory, as a reviewer's would.
     * Unset means DEFAULT_HEAP_MIB, not node's own default (about 4 GiB on this Mac), which the GenesisTools root
     * program exceeded before 2026-10-25: a measurement must finish, a limit is asked for on purpose.
     */
    heapMiB?: number;
    /** The check is killed (its whole process group) after this long. Default DEFAULT_TIMEOUT_MS. */
    timeoutMs?: number;
    /** Aborts the check, as Ctrl-C does through `withInterrupt`. */
    signal?: AbortSignal;
    files?: string[];
}

/** The tsconfig to check: a path to the file, or a folder holding `tsconfig.json`. */
export function resolveTsconfig(input: string | undefined): string {
    const path = resolve(input ?? "tsconfig.json");
    const file = existsSync(join(path, "tsconfig.json")) ? join(path, "tsconfig.json") : path;

    if (!existsSync(file)) {
        throw new UsageError(`no tsconfig at ${file}`);
    }

    return file;
}

/** Checked before the spawn, so a worker's own "not found" error is never mistaken for a missing node. */
function requireNode(): void {
    if (!Bun.which("node")) {
        throw new UsageError("node is not on PATH; install it or pass --runtime bun (JavaScriptCore heap numbers)");
    }
}

interface BoundedRun {
    command: string[];
    timeoutMs: number;
    signal?: AbortSignal;
    environment?: Record<string, string | undefined>;
    what: string;
}

/** A child with a deadline: on expiry or abort its process group gets SIGTERM, then SIGKILL. */
function seconds(ms: number): string {
    return ms < 1000 ? `${ms} ms` : `${Math.round(ms / 1000)} s`;
}

async function runBounded(run: BoundedRun): Promise<{ status: number | null; stderr: string }> {
    // boundedCommand throws a bare AbortError for a signal that is already aborted; it starts no child either way.
    if (run.signal?.aborted) {
        throw new UsageError(`${run.what} was interrupted`);
    }

    const result = await boundedCommand({
        command: run.command,
        timeoutMs: run.timeoutMs,
        signal: run.signal,
        maxBufferBytes: OUTPUT_BUDGET_BYTES,
        environment: run.environment,
    });

    if (result.error?.code === "ETIMEDOUT") {
        throw new UsageError(
            `${run.what} did not finish in ${seconds(run.timeoutMs)} and was stopped; pass a larger --timeout`
        );
    }

    if (result.error?.code === "ABORT_ERR") {
        throw new UsageError(`${run.what} was interrupted`);
    }

    if (result.error) {
        throw new Error(`${run.what} failed: ${result.error.message}`, { cause: result.error });
    }

    return { status: result.status, stderr: result.stderr };
}

export async function runProgramWorker(mode: "phases", options: ProgramRunOptions): Promise<PhasesResult>;
export async function runProgramWorker(mode: "files", options: ProgramRunOptions): Promise<FilesResult>;
export async function runProgramWorker(mode: "own", options: ProgramRunOptions): Promise<OwnResult>;
export async function runProgramWorker(mode: "graph", options: ProgramRunOptions): Promise<GraphResult>;
export async function runProgramWorker(mode: "sites", options: ProgramRunOptions): Promise<SitesResult>;
export async function runProgramWorker(mode: ProgramMode, options: ProgramRunOptions): Promise<WorkerResult> {
    const runtime = options.runtime ?? "node";

    if (runtime === "node") {
        requireNode();
    }

    const dir = mkdtempSync(join(tmpdir(), "gt-ts-program-"));
    const outPath = join(dir, "result.json");
    const cmd =
        runtime === "node"
            ? ["node", "--expose-gc", `--max-old-space-size=${options.heapMiB ?? DEFAULT_HEAP_MIB}`, WORKER]
            : [process.execPath, "--smol", WORKER];

    logger.debug({ mode, runtime, tsconfig: options.tsconfig, cmd }, "ts program: spawning check worker");

    try {
        const { status, stderr } = await runBounded({
            command: cmd,
            timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
            signal: options.signal,
            what: "the check",
            environment: {
                ...env.getProcessEnv(),
                GT_TSP_CONFIG: options.tsconfig,
                GT_TSP_MODE: mode,
                GT_TSP_FILES: (options.files ?? []).map((file) => resolve(file)).join("\n"),
                GT_TSP_OUT: outPath,
            },
        });

        if (status !== 0 || !existsSync(outPath)) {
            logger.warn({ mode, runtime, status, stderr: stderr.slice(-2000) }, "ts program: check worker failed");

            // An out-of-memory run is a result (the program does not fit that heap), not a crash to dump.
            if (/heap out of memory|Reached heap limit/i.test(stderr)) {
                throw new UsageError(
                    `the program does not fit in ${options.heapMiB ?? DEFAULT_HEAP_MIB} MiB of heap (out of memory); pass a larger --heap to measure it`
                );
            }

            throw new Error(
                `the check worker failed (exit ${status}): ${stderr.trim().split("\n").slice(-3).join(" ")}`
            );
        }

        const result: WorkerResult = SafeJSON.parse(readFileSync(outPath, "utf8"), { strict: true });
        return result;
    } finally {
        removeRecursive(dir);
    }
}

export interface TraceRunOptions {
    tsconfig: string;
    heapMiB?: number;
    timeoutMs?: number;
    signal?: AbortSignal;
}

/** `tsc --generateTrace` of the project's own TypeScript, under node, into a dated folder; returns the folder. */
export async function generateTrace(options: TraceRunOptions): Promise<string> {
    requireNode();
    const require = createRequire(options.tsconfig);
    let tsc: string;

    try {
        tsc = require.resolve("typescript/lib/tsc.js");
    } catch (error) {
        throw new UsageError(`no typescript/lib/tsc.js resolvable from ${dirname(options.tsconfig)}`, { cause: error });
    }

    const dir = toolDataDir("ts", "traces", new Date().toISOString().replace(/[:.]/g, "-"));
    mkdirSync(dir, { recursive: true });

    try {
        return await traceInto(dir, tsc, options);
    } catch (error) {
        // A stopped or failed tsc leaves a partial trace that no later read can use.
        removeRecursive(dir);
        throw error;
    }
}

async function traceInto(dir: string, tsc: string, options: TraceRunOptions): Promise<string> {
    const { status, stderr } = await runBounded({
        command: [
            "node",
            `--max-old-space-size=${options.heapMiB ?? DEFAULT_HEAP_MIB}`,
            tsc,
            "-p",
            options.tsconfig,
            "--noEmit",
            "--pretty",
            "false",
            "--generateTrace",
            dir,
        ],
        timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        signal: options.signal,
        what: "tsc --generateTrace",
    });

    // tsc exits 1 or 2 when the program has errors; the trace is still complete.
    if (status === null || status > 2 || !existsSync(join(dir, "trace.json"))) {
        throw new Error(
            `tsc --generateTrace failed (exit ${status}): ${stderr.trim().split("\n").slice(-3).join(" ")}`
        );
    }

    return dir;
}
