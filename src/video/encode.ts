import { readdirSync, renameSync, rmSync, statSync, utimesSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { formatBytes, formatDuration } from "@genesiscz/utils/format";
import { logger, out } from "@genesiscz/utils/logger";
import { boundedCommand } from "@genesiscz/utils/process/bounded-command";
import {
    defaultRuleContext,
    graceMinutesFor,
    kickDrainer,
    loadRmConfig,
    moveToTrash,
    planRemoval,
    rmCallerFromRuntime,
} from "@genesiscz/utils/rm";
import { createBoxTable, truncateDisplay } from "@genesiscz/utils/table";
import { readMediaFacts } from "@genesiscz/utils/video/media-facts";
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
    /** The trash batch holding the original after `--replace`; `tools rm restore <id>` undoes it. */
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

function removeOwnTemp(path: string): void {
    rmSync(path, { force: true });
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

type ReplaceOutcome = { batch: string } | { beside: string };

function replaceOriginal({ input, finished }: { input: string; finished: string }): ReplaceOutcome {
    const config = loadRmConfig();
    const caller = rmCallerFromRuntime();
    const ctx = defaultRuleContext(config, caller, process.cwd());
    const [item] = planRemoval([input], ctx);

    if (!item) {
        throw new Error("the trash rules gave no verdict for the original");
    }

    const decision = replaceDecision({
        verdict: item.verdict.kind,
        reason: item.verdict.reason,
        isInAgent: caller.isInAgent,
    });

    if (decision.kind === "refuse") {
        throw new Error(decision.reason);
    }

    if (decision.kind === "beside") {
        return { beside: decision.reason };
    }

    const before = statSync(input);
    const batch = moveToTrash([{ target: item.target, rule: "video-encode-replace" }], {
        config,
        caller,
        graceMinutes: graceMinutesFor(item, ctx),
    });

    if (!batch) {
        throw new Error("the original did not move to the trash");
    }

    kickDrainer(config);
    renameSync(finished, input);
    utimesSync(input, before.atime, before.mtime);
    return { batch: batch.id };
}

async function encodeOne({ input, options }: { input: string; options: EncodeOptions }): Promise<EncodeRow> {
    const { encoder } = options;
    const started = performance.now();
    const bytes = statSync(input).size;
    const row = emptyRow(input, bytes);
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
        logger.debug({ input, error }, "ffprobe could not read the input");
        return finish({ reason: "not a video (ffprobe cannot read it)" });
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

    const ext = extname(input);
    const temp = join(dirname(input), `${basename(input, ext)}.${encoder.codec}-tmp${ext}`);

    try {
        const run = await boundedCommand({
            command: ["nice", "-n", "10", ...encodeArgs({ encoder, input, output: temp, quality: options.quality })],
            timeoutMs: 4 * 60 * 60_000,
            signal: options.signal,
        });

        if (run.error || run.status !== 0) {
            removeOwnTemp(temp);
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
            removeOwnTemp(temp);
            return finish({
                status: "discarded",
                outputBytes: output.bytes,
                saving,
                reason: verdict.reason,
            });
        }

        let trashBatch: string | null = null;
        let status: EncodeStatus = "kept";
        let reason = verdict.reason;
        let outputPath = finalPath;

        if (options.replace) {
            const sibling = siblingOutput({ input, encoder });
            const outcome = replaceOriginal({ input, finished: temp });

            if ("batch" in outcome) {
                trashBatch = outcome.batch;
            } else if (await Bun.file(sibling).exists()) {
                removeOwnTemp(temp);
                return finish({
                    status: "discarded",
                    outputBytes: output.bytes,
                    saving,
                    reason: `${outcome.beside}; ${sibling} already exists`,
                });
            } else {
                renameSync(temp, sibling);
                status = "kept-beside";
                reason = `${verdict.reason}; kept beside the original: ${outcome.beside}`;
                outputPath = sibling;
            }
        } else {
            renameSync(temp, finalPath);
        }

        return finish({
            status,
            kept: true,
            output: outputPath,
            outputBytes: output.bytes,
            saving,
            reason,
            trashBatch,
        });
    } catch (error) {
        removeOwnTemp(temp);
        logger.warn({ input, error }, "Video encode failed");
        return finish({ status: "failed", reason: error instanceof Error ? error.message : String(error) });
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
        if (row.trashBatch) {
            out.println(
                `undo ${basename(row.input)}: mv ${shellQuote(row.input)} ${shellQuote(siblingOutput({ input: row.input, encoder }))}` +
                    ` && tools rm restore ${row.trashBatch}`
            );
        }
    }

    const beside = rows.filter((row) => row.status === "kept-beside");

    if (beside.length > 0) {
        out.println(
            `${beside.length} original(s) stay because an agent may not remove them. A person finishes at a terminal: ` +
                `tools rm ${beside.map((row) => shellQuote(row.input)).join(" ")}`
        );
    }

    const wording = dryRun ? "dry run, nothing written. " : "";
    out.println(
        `${wording}${summary.files} files, ${summary.kept} kept, ${formatBytes(summary.bytesBefore)} -> ${formatBytes(summary.bytesAfter)} ` +
            `(kept files only), ${formatDuration(summary.seconds, "s")}`
    );
}
