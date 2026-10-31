import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { formatLocalDateTimeStamp } from "@genesiscz/utils/date";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger, out } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import pc from "picocolors";
import { DEFAULT_REGION_OPTIONS } from "../lib/diff-regions";
import {
    copyRaw,
    loadReportInput,
    orderLines,
    type PairResult,
    parseReportNotes,
    previewOpenCommand,
    type ReportNotes,
    renderReportMarkdown,
    reportPair,
} from "../lib/report";

interface ReportCommandOptions {
    out: string;
    note?: string;
    notes?: string;
    title?: string;
    threshold: string;
    mergeDistance: string;
    minArea: string;
    resizeToMatch?: boolean;
    raw?: boolean;
    json?: boolean;
}

function numberOption(value: string, flag: string, { max }: { max?: number } = {}): number {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0 || (max !== undefined && parsed > max)) {
        logger.error(`${flag} must be a number from 0${max === undefined ? "" : ` to ${max}`} (got "${value}")`);
        process.exit(2);
    }

    return parsed;
}

async function readNotes(path: string | undefined): Promise<ReportNotes> {
    if (!path) {
        return {};
    }

    const file = Bun.file(path);
    if (!(await file.exists())) {
        logger.error(`notes file not found: ${path}`);
        process.exit(2);
    }

    return parseReportNotes(SafeJSON.parse(await file.text(), { strict: true }));
}

export function registerReportCommand(program: Command): void {
    program
        .command("report <input>")
        .description(
            'Annotated before/after report. <input> is a shot list JSON ({"title"?, "pairs": [{"screen", "before", "after", "fix"?, "note"?}]}, paths relative to the file) or a folder of <stem>-before / <stem>-after images.\nPer pair: the geometry check (another point size is refused unless --resize-to-match), the pixel regions, and the view-tree diff when both shots have <shot>.tree.json (a hub --snapshot with --snapshot-tree). Red = a change (a tree change, or any region when no tree exists), amber = data only.\nWrites NN-<screen>-1-before.png / NN-<screen>-2-after.png into --out, an order.txt, a markdown note, and prints the one-line command that opens the pairs side by side in Preview.\nExit 0 = every pair reported, 1 = a pair was refused, 2 = unusable input.'
        )
        .requiredOption("--out <dir>", "a fresh folder for the annotated pairs and order.txt")
        .option("--note <path>", "where to write the markdown note (default <out>/report.md)")
        .option("--notes <json>", 'change notes per screen: {"<screen>": {"fix": "H12", "note": "one sentence"}}')
        .option("--title <text>", "the note's title (default: the shot list's title)")
        .option("--threshold <0..1>", "per-pixel colour-distance sensitivity", "0.1")
        .option(
            "--merge-distance <px>",
            "changes at most this far apart join one box",
            String(DEFAULT_REGION_OPTIONS.mergeDistance)
        )
        .option("--min-area <px>", "drop a box with fewer mismatched pixels", String(DEFAULT_REGION_OPTIONS.minArea))
        .option("--resize-to-match", "resample the after to the before's size instead of refusing another point size")
        .option("--raw", "also copy the unannotated pairs into <out>/raw with the same names")
        .option("--json", "machine-readable result JSON on stdout")
        .action(async (input: string, opts: ReportCommandOptions) => {
            const inputPath = resolve(input);
            if (
                !(await Bun.file(inputPath).exists()) &&
                !(await Bun.file(inputPath)
                    .stat()
                    .catch(() => undefined))
            ) {
                logger.error(`input not found: ${inputPath}`);
                process.exit(2);
            }

            const threshold = numberOption(opts.threshold, "--threshold", { max: 1 });
            const mergeDistance = numberOption(opts.mergeDistance, "--merge-distance");
            const minArea = numberOption(opts.minArea, "--min-area");
            const notes = await readNotes(opts.notes);
            const report = await loadReportInput(inputPath, notes);
            if (report.pairs.length === 0) {
                logger.error(`no before/after pairs in ${inputPath}`);
                process.exit(2);
            }

            const outDir = resolve(opts.out);
            await mkdir(outDir, { recursive: true });
            const results: PairResult[] = [];
            for (const [index, pair] of report.pairs.entries()) {
                for (const path of [pair.before, pair.after]) {
                    if (!(await Bun.file(path).exists())) {
                        logger.error(`${pair.screen}: image not found: ${path}`);
                        process.exit(2);
                    }
                }

                const result = await reportPair(pair, index + 1, {
                    outDir,
                    threshold,
                    mergeDistance,
                    minArea,
                    resizeToMatch: opts.resizeToMatch,
                });
                if (opts.raw && result.status === "ok") {
                    await copyRaw(result, outDir);
                }

                results.push(result);
                if (!opts.json) {
                    const red = result.regions.filter((region) => region.kind === "change").length;
                    const amber = result.regions.length - red;
                    const status =
                        result.status === "refused"
                            ? pc.red(`refused: ${result.message}`)
                            : `${pc.red(`${red} red`)}, ${pc.yellow(`${amber} amber`)}${result.tree ? `, tree ${result.tree.changes.length} change(s)` : ", no tree"}`;
                    out.log.info(`${String(index + 1).padStart(2, "0")} ${pair.screen}: ${status}`);
                }
            }

            const orderFile = join(outDir, "order.txt");
            await Bun.write(orderFile, `${orderLines(results).join("\n")}\n`);
            const openCommand = previewOpenCommand(orderFile);
            const notePath = resolve(opts.note ?? join(outDir, "report.md"));
            const markdown = renderReportMarkdown({
                title: opts.title ?? report.title,
                results,
                notePath,
                openCommand,
                writtenAt: formatLocalDateTimeStamp(new Date(), { seconds: false }),
            });
            await Bun.write(notePath, markdown);
            const refused = results.filter((result) => result.status === "refused").length;
            logger.debug({ input: inputPath, outDir, notePath, pairs: results.length, refused }, "control report");

            if (opts.json) {
                out.result({
                    ok: refused === 0,
                    note: notePath,
                    order: orderFile,
                    open: openCommand,
                    pairs: results.map(({ regions, tree, ...rest }) => ({
                        ...rest,
                        regions,
                        treeChanges: tree?.changes,
                        treeDataOnly: tree?.dataOnly.length,
                    })),
                });
            } else {
                out.println(`note: ${notePath}`);
                out.println(`order: ${orderFile}`);
                out.println(`open side by side: ${openCommand}`);
                if (refused > 0) {
                    out.println(pc.red(`${refused} pair(s) refused: render both sides at the same size and scale`));
                }
            }

            process.exit(refused === 0 ? 0 : 1);
        });
}
