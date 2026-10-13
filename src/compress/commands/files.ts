import { createWriteStream } from "node:fs";
import { suggestEnumFlag } from "@genesiscz/utils/cli";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import {
    CompressRefusal,
    compressPath,
    expandPath,
    planCompressPath,
    verifyPath,
} from "@genesiscz/utils/compress/operations";
import { isPresetName, PRESET_NAMES, PRESETS } from "@genesiscz/utils/compress/presets";
import { readZstdFrames } from "@genesiscz/utils/compress/zstd";
import { formatBytes } from "@genesiscz/utils/format";
import { logger, out } from "@genesiscz/utils/logger";
import { renderCliKeyRow } from "@genesiscz/utils/table";
import type { Command } from "commander";
import pc from "picocolors";

const { log } = logger.scoped("compress");

interface PackOptions {
    preset?: string | boolean;
    level?: string;
    minSaving?: string;
    removeOriginal?: boolean;
    force?: boolean;
    output?: string;
    dryRun?: boolean;
    json?: boolean;
}

function percent(share: number): string {
    return Number.isFinite(share) ? `${(share * 100).toFixed(1)}%` : "—";
}

/** `--preset auto` or no flag: resolved from the data. An unknown name prints the possible values. */
function presetOption(value: string | boolean | undefined) {
    if (value === undefined || value === "auto") {
        return { ok: true as const, preset: undefined };
    }

    if (typeof value === "string" && isPresetName(value)) {
        return { ok: true as const, preset: PRESETS[value] };
    }

    out.printlnErr(
        suggestEnumFlag(toolCommand("compress"), "--preset", ["auto", ...PRESET_NAMES], { subcommand: ["pack"] })
    );
    return { ok: false as const };
}

async function runPack(paths: string[], options: PackOptions): Promise<void> {
    const preset = presetOption(options.preset);

    if (!preset.ok) {
        process.exitCode = 1;
        return;
    }

    if (options.output && paths.length > 1) {
        out.error("--output takes one input only.");
        process.exitCode = 1;
        return;
    }

    const level = options.level ? Number(options.level) : undefined;
    const minSaving = options.minSaving !== undefined ? Number(options.minSaving) / 100 : undefined;
    const results: unknown[] = [];

    for (const source of paths) {
        const common = {
            source,
            target: options.output,
            preset: preset.preset,
            level,
            minSaving,
            force: options.force,
        };

        try {
            const plan = await planCompressPath(common);

            if (options.dryRun || plan.refusal) {
                results.push({ ...plan, preset: plan.preset.name, wrote: false });

                if (!options.json) {
                    out.println(`${pc.bold(source)}  ${plan.isFolder ? "folder" : "file"} → ${plan.target}`);
                    renderCliKeyRow(
                        "preset",
                        `${plan.preset.name} (level ${plan.level}${plan.preset.long ? ", long" : ""}; ${plan.reason})`,
                        12
                    );
                    renderCliKeyRow("trial", `saves ${percent(plan.trialSaving)} on a sample`, 12);
                    renderCliKeyRow(
                        "estimate",
                        `${formatBytes(plan.inputBytes)} → about ${formatBytes(plan.estimatedBytes)}`,
                        12
                    );
                    renderCliKeyRow(
                        "result",
                        plan.refusal ? pc.yellow(`skipped: ${plan.refusal}`) : pc.dim("dry run, nothing written"),
                        12
                    );
                }

                if (plan.refusal && !options.dryRun) {
                    process.exitCode = 1;
                }

                continue;
            }

            const { record, warning } = await compressPath({
                ...common,
                removeOriginal: options.removeOriginal,
                caller: "cli",
            });
            results.push({ ...record, warning });

            if (!options.json) {
                out.log.success(
                    `${record.source} → ${record.target}: ${formatBytes(record.sourceBytes)} → ${formatBytes(record.targetBytes)} (x${record.ratio.toFixed(1)}, ${record.preset} level ${record.level}), verified${record.removedOriginal ? ", original removed" : ", original kept"}`
                );

                if (warning) {
                    out.log.warn(warning);
                }
            }
        } catch (err) {
            process.exitCode = 1;
            results.push({ source, error: err instanceof Error ? err.message : String(err) });
            log.debug({ err, source }, "compress pack failed");

            if (!options.json) {
                out.error(
                    err instanceof CompressRefusal
                        ? err.message
                        : `${source}: ${err instanceof Error ? err.message : err}`
                );
            }
        }
    }

    if (options.json) {
        out.result(results);
    }
}

async function runUnpack(
    archives: string[],
    options: { into?: string; removeArchive?: boolean; json?: boolean }
): Promise<void> {
    const results: unknown[] = [];

    for (const archive of archives) {
        try {
            const record = await expandPath({
                archive,
                into: options.into,
                removeArchive: options.removeArchive,
                caller: "cli",
            });
            results.push(record);

            if (!options.json) {
                out.log.success(`${record.source} → ${record.target}: ${formatBytes(record.targetBytes)} restored`);
            }
        } catch (err) {
            process.exitCode = 1;
            results.push({ archive, error: err instanceof Error ? err.message : String(err) });
            log.debug({ err, archive }, "compress unpack failed");

            if (!options.json) {
                out.error(`${archive}: ${err instanceof Error ? err.message : err}`);
            }
        }
    }

    if (options.json) {
        out.result(results);
    }
}

function runVerify(archive: string, options: { against?: string; json?: boolean }): void {
    try {
        const result = verifyPath({ archive, against: options.against });

        if (!result.ok) {
            process.exitCode = 1;
        }

        if (options.json) {
            out.result({ archive, ...result, entries: result.entries?.length });
            return;
        }

        const line = `${archive}: ${result.kind}, ${result.detail}`;

        if (result.ok) {
            out.log.success(line);
        } else {
            out.error(line);
        }
    } catch (err) {
        process.exitCode = 1;
        log.debug({ err, archive }, "compress verify failed");
        out.error(`${archive}: does not decode (${err instanceof Error ? err.message : err})`);
    }
}

/** Streams a `.zst` file's content to stdout (or `--output`), frame by frame: `tools compress cat x.log.zst | rg …`. */
async function runCat(archive: string, options: { output?: string }): Promise<void> {
    if (!options.output) {
        await writeFrames(archive, process.stdout);
        return;
    }

    const file = createWriteStream(options.output);
    await writeFrames(archive, file);
    await new Promise<void>((resolve) => file.end(() => resolve()));
}

/** Raw bytes with backpressure: a slow reader (`| less`) never makes the whole file queue up in memory. */
async function writeFrames(archive: string, sink: NodeJS.WritableStream): Promise<void> {
    for await (const frame of readZstdFrames(archive)) {
        if (!sink.write(frame)) {
            await new Promise<void>((resolve) => sink.once("drain", () => resolve()));
        }
    }
}

export function registerFileCommands(program: Command): void {
    program
        .command("pack")
        .description(
            "Compress files to <file>.zst and folders to <folder>.zst (tar inside zstd), verified before anything else"
        )
        .argument("<paths...>", "files or folders")
        .option("--preset [name]", `auto (default) or one of: ${PRESET_NAMES.join(", ")}`)
        .option("-l, --level <n>", "zstd level, overriding the preset's")
        .option("--min-saving <percent>", "skip when a trial on a sample saves less (default 30)")
        .option("--remove-original", "remove the original after the output is verified (default: keep it)")
        .option("--force", "compress even when the trial saves too little")
        .option("-o, --output <path>", "output path (one input only)")
        .option("--dry-run", "show the preset, the trial saving and the estimate; write nothing")
        .option("--json", "machine-readable result")
        .action(runPack);

    program
        .command("unpack")
        .description("Restore <x>.zst: a packed folder back to <x>/, a compressed file back to <x>; never overwrites")
        .argument("<archives...>", ".zst files (a .tar.zst is accepted too)")
        .option("--into <dir>", "folder to restore into (default: next to the archive)")
        .option("--remove-archive", "remove the archive after the restore finished")
        .option("--json", "machine-readable result")
        .action(runUnpack);

    program
        .command("verify")
        .description(
            "Read a .zst end to end (frame checksums, tar listing with sha256), optionally against the original"
        )
        .argument("<archive>", ".zst file")
        .option("--against <path>", "the original file or folder to compare with")
        .option("--json", "machine-readable result")
        .action(runVerify);

    program
        .command("cat")
        .description("Write a .zst file's content to stdout, one frame at a time (for rg, jq, less)")
        .argument("<file>", ".zst file")
        .option("-o, --output <path>", "write to a file instead of stdout")
        .action(runCat);
}
