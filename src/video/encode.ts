import { mkdtempSync, readdirSync, rmSync, statSync, utimesSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { formatBytes, formatDuration } from "@genesiscz/utils/format";
import { logger, out } from "@genesiscz/utils/logger";
import { boundedCommand } from "@genesiscz/utils/process/bounded-command";
import {
    DESTINATION_TAKEN,
    defaultRuleContext,
    graceMinutesFor,
    identityOf,
    kickDrainer,
    loadRmConfig,
    moveToTrash,
    planRemoval,
    type RmConfig,
    RmPartialMoveError,
    renameNoReplace,
    restoreBatch,
    rmCallerFromRuntime,
    type TrashPaths,
} from "@genesiscz/utils/rm";
import { createBoxTable, truncateDisplay } from "@genesiscz/utils/table";
import { NotMediaError, readMediaFacts } from "@genesiscz/utils/video/media-facts";
import {
    decodeErrors,
    encodeArgs,
    judgeOutput,
    savingPercent,
    skipReason,
    type VideoEncoder,
} from "@genesiscz/utils/video/reencode";

export type EncodeStatus = "planned" | "kept" | "kept-beside" | "discarded" | "skipped" | "failed";

export interface EncodeRow {
    input: string;
    output: string | null;
    inputBytes: number;
    outputBytes: number | null;
    /** Percent smaller than the input; null when nothing was encoded. */
    saving: number | null;
    kept: boolean;
    status: EncodeStatus;
    reason: string;
    /**
     * The trash batch holding the original after `--replace`; the rm tool's restore verb undoes it. A `failed` row
     * carries it when the result could not take the original path and the original could not be put back.
     */
    trashBatch: string | null;
    seconds: number;
}

export interface EncodeOptions {
    paths: string[];
    encoder: VideoEncoder;
    quality: number;
    jobs: number;
    minSavingPct: number;
    replace: boolean;
    dryRun: boolean;
    signal?: AbortSignal;
    /** How `--replace` asks the trash about an original; the GenesisTools trash unless a test passes another. */
    planReplace?: (input: string) => PlannedReplace;
}

/** Files named on the command line, plus every file with a container extension inside a named folder. */
export function collectInputs({ paths, encoder }: { paths: string[]; encoder: VideoEncoder }): string[] {
    const found: string[] = [];

    function walk(dir: string): void {
        for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
            const full = join(dir, entry.name);

            if (entry.name.startsWith(".")) {
                continue;
            }

            if (entry.isDirectory()) {
                walk(full);
            } else if (entry.isFile() && encoder.containers.includes(extname(entry.name).toLowerCase())) {
                found.push(full);
            }
        }
    }

    for (const path of paths) {
        const full = resolve(path);

        if (statSync(full).isDirectory()) {
            walk(full);
        } else {
            found.push(full);
        }
    }

    return [...new Set(found)];
}

/** A sibling name `<name>.hevc<ext>`; a file already named that is an earlier output, not an input. */
export function siblingOutput({ input, encoder }: { input: string; encoder: VideoEncoder }): string {
    const ext = extname(input);
    return join(dirname(input), `${basename(input, ext)}.${encoder.codec}${ext}`);
}

export function isEarlierOutput({ input, encoder }: { input: string; encoder: VideoEncoder }): boolean {
    return basename(input, extname(input)).endsWith(`.${encoder.codec}`);
}

/** The original as the encode found it, taken before the probe; a result is installed only over this same file. */
export interface SourceSnapshot {
    /** Device and inode (`identityOf`), what a trash move is pinned to. */
    identity: string | null;
    size: number;
    mtimeMs: number;
}

export function snapshotSource(path: string): SourceSnapshot {
    const stat = statSync(path);
    return { identity: identityOf(path), size: stat.size, mtimeMs: stat.mtimeMs };
}

/** Why `path` no longer holds the file `source` describes, or null when it still does. */
export function sourceChange({ source, path }: { source: SourceSnapshot; path: string }): string | null {
    let now: SourceSnapshot;

    try {
        now = snapshotSource(path);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return "it is gone";
        }

        throw error;
    }

    if (now.identity !== source.identity) {
        return "another file took its path";
    }

    if (now.size !== source.size || now.mtimeMs !== source.mtimeMs) {
        return "it was modified";
    }

    return null;
}

function emptyRow(input: string, inputBytes: number): EncodeRow {
    return {
        input,
        output: null,
        inputBytes,
        outputBytes: null,
        saving: null,
        kept: false,
        status: "skipped",
        reason: "",
        trashBatch: null,
        seconds: 0,
    };
}

async function pool<T>(items: T[], size: number, work: (item: T) => Promise<void>): Promise<void> {
    let next = 0;
    const workers = Array.from({ length: Math.max(1, Math.min(size, items.length)) }, async () => {
        while (next < items.length) {
            await work(items[next++]);
        }
    });
    await Promise.all(workers);
}

export interface Staging {
    /** A new hidden folder beside the input, owned by this run alone; the folder walk skips it. */
    dir: string;
    /** Where ffmpeg writes the encode. */
    file: string;
}

/** The encode is written beside the input (same volume, so the install is a rename) in a folder no other run shares. */
export function makeStaging({ input, encoder }: { input: string; encoder: VideoEncoder }): Staging {
    const dir = mkdtempSync(join(dirname(input), `.${basename(input)}.${encoder.codec}-`));
    return { dir, file: join(dir, basename(siblingOutput({ input, encoder }))) };
}

export type ReplaceDecision =
    | { kind: "replace" }
    | { kind: "beside"; reason: string }
    | { kind: "refuse"; reason: string };

/**
 * What `--replace` may do with one original. The trash rules decide: "deny" stops everyone, and "ask" needs a person,
 * so an agent keeps the verified result beside the original instead.
 */
export function replaceDecision({
    verdict,
    reason,
    isInAgent,
}: {
    verdict: "allow" | "ask" | "deny";
    reason: string;
    isInAgent: boolean;
}): ReplaceDecision {
    if (verdict === "deny") {
        return { kind: "refuse", reason: `the trash rules refuse the original: ${reason}` };
    }

    if (verdict === "ask" && isInAgent) {
        return { kind: "beside", reason: `an agent may not replace this file without a person's approval (${reason})` };
    }

    return { kind: "replace" };
}

/** The trash rules' answer for one original under `--replace`, and the steps that act on it. */
export interface PlannedReplace {
    verdict: "allow" | "ask" | "deny";
    reason: string;
    isInAgent: boolean;
    /** The device and inode the rules judged; the trash move takes only the file that still has it. */
    identity: string | null;
    /**
     * Moves the original into the trash; the batch id, or null when it did not move. Throws `RmPartialMoveError`
     * when the original reached the trash and a later step of the move failed.
     */
    moveOriginal: () => string | null;
    /** Puts the batch back; true when the original is at its path again. */
    restore: (batch: string) => boolean;
    /** Starts the background drainer, once the result holds the original path. */
    startDrainer: () => void;
}

/** What `planReplaceWithRm` works on: the saved rm config, its trash and the real drainer unless a test passes others. */
export interface RmReplaceDeps {
    /** An rm config to use instead of the saved one; its trash root is then the one in force for the move. */
    config?: RmConfig;
    paths?: TrashPaths;
    startDrainer?: () => void;
}

/** `--replace` through the GenesisTools trash and the `tools rm` rules. */
export function planReplaceWithRm(input: string, deps: RmReplaceDeps = {}): PlannedReplace {
    const config = deps.config ?? loadRmConfig();
    const caller = rmCallerFromRuntime();
    const ctx = defaultRuleContext(config, caller, process.cwd());
    const [item] = planRemoval([input], ctx);

    if (!item) {
        throw new Error("the trash rules gave no verdict for the original");
    }

    return {
        verdict: item.verdict.kind,
        reason: item.verdict.reason,
        isInAgent: caller.isInAgent,
        identity: item.target.identity,
        moveOriginal: () =>
            moveToTrash([{ target: item.target, rule: "video-encode-replace" }], {
                config,
                caller,
                graceMinutes: graceMinutesFor(item, ctx),
                paths: deps.paths,
                currentTrashRoot: deps.config ? () => config.trashRoot : undefined,
            })?.id ?? null,
        restore: (batch) => restoreBatch(batch, { config, caller, paths: deps.paths }).restored.length > 0,
        startDrainer: deps.startDrainer ?? (() => kickDrainer(config, deps.paths)),
    };
}

/** The result could not take the original path after the move; `trashBatch` is set while the original waits there. */
export class ReplaceInstallError extends Error {
    constructor(
        message: string,
        readonly trashBatch: string | null
    ) {
        super(message);
        this.name = "ReplaceInstallError";
    }
}

export interface InstallResult {
    status: Extract<EncodeStatus, "kept" | "kept-beside" | "discarded">;
    output: string | null;
    reason: string;
    trashBatch: string | null;
}

/** Moves the staged file to `target` only when nothing is there; a taken name discards the result. */
function claimName({
    staged,
    target,
    status,
    reason,
    takenReason,
}: {
    staged: string;
    target: string;
    status: "kept" | "kept-beside";
    reason: string;
    takenReason: string;
}): InstallResult {
    try {
        renameNoReplace(staged, target);
    } catch (error) {
        if (!DESTINATION_TAKEN.has((error as NodeJS.ErrnoException).code ?? "")) {
            throw error;
        }

        return {
            status: "discarded",
            output: null,
            reason: `${takenReason}${target} already exists`,
            trashBatch: null,
        };
    }

    return { status, output: target, reason, trashBatch: null };
}

/** Puts the original back from `batch` after `failure` (a sentence: what went wrong, and why). */
function rollBack({
    plan,
    batch,
    failure,
}: {
    plan: PlannedReplace;
    batch: string;
    failure: string;
}): ReplaceInstallError {
    let restored = false;

    try {
        restored = plan.restore(batch);
    } catch (error) {
        logger.warn({ batch, error }, "the original could not be put back after a failed replace");
    }

    return restored
        ? new ReplaceInstallError(`${failure}; the original is back`, null)
        : new ReplaceInstallError(`${failure}; the original waits in trash batch ${batch}`, batch);
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** A discarded result when `input` is no longer the file the encode read (or not the one the rules judged), else null. */
function sourceChanged({
    source,
    input,
    judged = source.identity,
}: {
    source: SourceSnapshot;
    input: string;
    judged?: string | null;
}): InstallResult | null {
    const why =
        sourceChange({ source, path: input }) ??
        (judged === source.identity ? null : "the trash rules judged another file at its path");

    if (!why) {
        return null;
    }

    return {
        status: "discarded",
        output: null,
        reason: `the original changed during the encode (${why}); the result was dropped`,
        trashBatch: null,
    };
}

/**
 * Puts a verified encode in place, only while `input` is still the file `source` describes (an edit or another run's
 * replace during the encode drops the result). Without `--replace` it takes the sibling name. With it the trash rules
 * decide (see `replaceDecision`); a replace moves the original to the trash, installs the result, puts the original
 * back when the move or the install fails, and starts the drainer only after the install holds.
 */
export function installVerified({
    input,
    source,
    staged,
    encoder,
    replace,
    keptReason,
    planReplace,
}: {
    input: string;
    source: SourceSnapshot;
    staged: string;
    encoder: VideoEncoder;
    replace: boolean;
    keptReason: string;
    planReplace: (input: string) => PlannedReplace;
}): InstallResult {
    const sibling = siblingOutput({ input, encoder });

    if (!replace) {
        return (
            sourceChanged({ source, input }) ??
            claimName({ staged, target: sibling, status: "kept", reason: keptReason, takenReason: "" })
        );
    }

    const plan = planReplace(input);
    const decision = replaceDecision(plan);

    if (decision.kind === "refuse") {
        throw new Error(decision.reason);
    }

    // Checked after the rules ran, right before the step that acts: the move is pinned to the file they judged.
    const changed = sourceChanged({ source, input, judged: plan.identity });

    if (changed) {
        return changed;
    }

    if (decision.kind === "beside") {
        return claimName({
            staged,
            target: sibling,
            status: "kept-beside",
            reason: `${keptReason}; kept beside the original: ${decision.reason}`,
            takenReason: `${decision.reason}; `,
        });
    }

    const before = statSync(input);
    let batch: string | null;

    try {
        batch = plan.moveOriginal();
    } catch (error) {
        if (error instanceof RmPartialMoveError) {
            throw rollBack({
                plan,
                batch: error.batch.id,
                failure: `the trash move failed after the original moved (${messageOf(error.cause)})`,
            });
        }

        throw error;
    }

    if (!batch) {
        throw new Error("the original did not move to the trash");
    }

    try {
        renameNoReplace(staged, input);
    } catch (error) {
        throw rollBack({
            plan,
            batch,
            failure: `the result could not take the original path (${messageOf(error)})`,
        });
    }

    try {
        utimesSync(input, before.atime, before.mtime);
    } catch (error) {
        logger.warn({ input, error }, "the replacement keeps its own timestamps");
    }

    try {
        plan.startDrainer();
    } catch (error) {
        logger.warn({ error }, `the trash drainer did not start; the next ${toolCommand("rm")} run starts it`);
    }

    return { status: "kept", output: input, reason: keptReason, trashBatch: batch };
}

/**
 * The row for a probe that threw: a file ffprobe read and rejected is skipped as not a video; anything else (no
 * ffprobe, a timeout, a file this process cannot read) is a failed row, so the run exits 1.
 */
export function probeFailureRow({
    input,
    error,
}: {
    input: string;
    error: unknown;
}): Pick<EncodeRow, "status" | "reason"> {
    if (error instanceof NotMediaError) {
        logger.debug({ input, error }, "ffprobe could not read the input as media");
        return { status: "skipped", reason: "not a video (ffprobe cannot read it)" };
    }

    logger.warn({ input, error }, "ffprobe did not run on the input");
    return { status: "failed", reason: `the probe failed: ${messageOf(error)}` };
}

async function encodeOne({ input, options }: { input: string; options: EncodeOptions }): Promise<EncodeRow> {
    const { encoder } = options;
    const started = performance.now();
    const source = snapshotSource(input);
    const row = emptyRow(input, source.size);
    const finish = (patch: Partial<EncodeRow>): EncodeRow => ({
        ...row,
        ...patch,
        seconds: (performance.now() - started) / 1000,
    });

    if (isEarlierOutput({ input, encoder })) {
        return finish({ reason: `an earlier .${encoder.codec} output` });
    }

    if (!encoder.containers.includes(extname(input).toLowerCase())) {
        return finish({ reason: `${extname(input) || "no extension"} cannot hold ${encoder.codec}` });
    }

    let facts: Awaited<ReturnType<typeof readMediaFacts>>;

    try {
        facts = await readMediaFacts({ input, signal: options.signal });
    } catch (error) {
        return finish(probeFailureRow({ input, error }));
    }

    const skip = skipReason({ facts, encoder });

    if (skip) {
        return finish({ reason: skip });
    }

    const finalPath = options.replace ? input : siblingOutput({ input, encoder });

    if (!options.replace && (await Bun.file(finalPath).exists())) {
        return finish({ output: finalPath, reason: "the output file already exists" });
    }

    if (options.dryRun) {
        return finish({ output: finalPath, status: "planned", reason: "would encode" });
    }

    let staging: Staging | null = null;

    try {
        staging = makeStaging({ input, encoder });
        const temp = staging.file;
        const run = await boundedCommand({
            command: encodeArgs({ encoder, input, output: temp, quality: options.quality }),
            timeoutMs: 4 * 60 * 60_000,
            signal: options.signal,
        });

        if (run.error || run.status !== 0) {
            return finish({
                status: "failed",
                reason: `ffmpeg failed: ${run.error?.message ?? run.stderr.slice(-300)}`,
            });
        }

        const output = await readMediaFacts({ input: temp, signal: options.signal });
        const errors = await decodeErrors({ encoder, path: temp, signal: options.signal });
        const verdict = judgeOutput({
            input: facts,
            output,
            encoder,
            minSavingPct: options.minSavingPct,
            decodeErrors: errors,
        });
        const saving = savingPercent({ inputBytes: facts.bytes, outputBytes: output.bytes });

        if (!verdict.keep) {
            return finish({
                status: "discarded",
                outputBytes: output.bytes,
                saving,
                reason: verdict.reason,
            });
        }

        const placed = installVerified({
            input,
            source,
            staged: temp,
            encoder,
            replace: options.replace,
            keptReason: verdict.reason,
            planReplace: options.planReplace ?? planReplaceWithRm,
        });

        return finish({
            ...placed,
            kept: placed.status !== "discarded",
            outputBytes: output.bytes,
            saving,
        });
    } catch (error) {
        logger.warn({ input, error }, "Video encode failed");
        return finish({
            status: "failed",
            reason: messageOf(error),
            trashBatch: error instanceof ReplaceInstallError ? error.trashBatch : null,
        });
    } finally {
        if (staging) {
            rmSync(staging.dir, { recursive: true, force: true });
        }
    }
}

export async function encodeVideos(options: EncodeOptions): Promise<EncodeRow[]> {
    const inputs = collectInputs({ paths: options.paths, encoder: options.encoder });
    const rows = new Map<string, EncodeRow>();
    await pool(inputs, options.jobs, async (input) => {
        rows.set(input, await encodeOne({ input, options }));
    });
    return inputs.map((input) => rows.get(input) as EncodeRow);
}

/** 1 when any file failed; skips and discards are results, not failures. */
export function exitCodeFor(rows: readonly EncodeRow[]): number {
    return rows.some((row) => row.status === "failed") ? 1 : 0;
}

export interface EncodeSummary {
    files: number;
    kept: number;
    bytesBefore: number;
    bytesAfter: number;
    seconds: number;
}

export function summarize({ rows, seconds }: { rows: EncodeRow[]; seconds: number }): EncodeSummary {
    const kept = rows.filter((row) => row.kept);
    return {
        files: rows.length,
        kept: kept.length,
        bytesBefore: kept.reduce((sum, row) => sum + row.inputBytes, 0),
        bytesAfter: kept.reduce((sum, row) => sum + (row.outputBytes ?? 0), 0),
        seconds,
    };
}

function shellQuote(path: string): string {
    return `'${path.replaceAll("'", "'\\''")}'`;
}

/**
 * The shell line that undoes a replace: the result moves to the sibling name without writing over a file already
 * there (`mv -n`), and `restore` runs only when the original path is free afterwards, since `mv -n` exits 0 when it
 * skips the move.
 */
export function undoCommand({
    input,
    encoder,
    restore,
}: {
    input: string;
    encoder: VideoEncoder;
    restore: string;
}): string {
    const result = shellQuote(input);
    return `mv -n ${result} ${shellQuote(siblingOutput({ input, encoder }))} && test ! -e ${result} && ${restore}`;
}

export function renderRows({
    rows,
    summary,
    dryRun,
    encoder,
}: {
    rows: EncodeRow[];
    summary: EncodeSummary;
    dryRun: boolean;
    encoder: VideoEncoder;
}) {
    const table = createBoxTable(["FILE", "SIZE", "NEW", "SAVED", "RESULT"]);

    for (const row of rows) {
        table.push([
            truncateDisplay(basename(row.input), 40),
            formatBytes(row.inputBytes),
            row.outputBytes === null ? "-" : formatBytes(row.outputBytes),
            row.saving === null ? "-" : `${row.saving.toFixed(1)}%`,
            `${row.status}: ${row.reason}`,
        ]);
    }

    out.println(table.toString());

    for (const row of rows) {
        if (!row.trashBatch) {
            continue;
        }

        if (row.status === "failed") {
            out.println(`restore ${basename(row.input)}: ${toolCommand("rm", "restore", row.trashBatch)}`);
        } else {
            const restore = toolCommand("rm", "restore", row.trashBatch);
            out.println(`undo ${basename(row.input)}: ${undoCommand({ input: row.input, encoder, restore })}`);
        }
    }

    const beside = rows.filter((row) => row.status === "kept-beside");

    if (beside.length > 0) {
        out.println(
            `${beside.length} original(s) stay because an agent may not remove them. A person finishes at a terminal: ` +
                toolCommand("rm", ...beside.map((row) => row.input))
        );
    }

    const wording = dryRun ? "dry run, nothing written. " : "";
    out.println(
        `${wording}${summary.files} files, ${summary.kept} kept, ${formatBytes(summary.bytesBefore)} -> ${formatBytes(summary.bytesAfter)} ` +
            `(kept files only), ${formatDuration(summary.seconds, "s")}`
    );
}
