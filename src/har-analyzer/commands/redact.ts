import { basename, dirname, join, resolve } from "node:path";
import { loadHarFile } from "@app/har-analyzer/core/parser";
import { parseRedactorFlags, type RedactionChange, redactHar } from "@app/har-analyzer/core/redactor";
import type { HarFile, OutputOptions } from "@app/har-analyzer/types";
import { ui } from "@genesiscz/utils/cli/ui";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger, out } from "@genesiscz/utils/logger";
import type { Command } from "commander";

interface FileReport {
    file: string;
    outputFile: string | null;
    backupFile: string | null;
    entryCount: number;
    changeCount: number;
    changes: RedactionChange[];
    skipped: string[];
    verified: boolean;
}

function summarizeByKind(changes: RedactionChange[]): Map<string, number> {
    const byKind = new Map<string, number>();
    for (const change of changes) {
        byKind.set(change.kind, (byKind.get(change.kind) ?? 0) + change.count);
    }
    return byKind;
}

function printChangeDetail(changes: RedactionChange[]): void {
    for (const change of changes) {
        ui.dim(
            `    e${change.entryIndex}  ${change.location}  [${change.kind}]${change.count > 1 ? ` ×${change.count}` : ""}`
        );
    }
}

export function registerRedactCommand(program: Command): void {
    program
        .command("redact <files...>")
        .description("Redact PII/credentials (passwords, emails, usernames, tokens, cookies) from HAR files")
        .option("-o, --output <file>", "Output path (single input file only)")
        .option("--in-place", "Rewrite the original file (backup saved to /tmp, restore command printed)")
        .option("--dry-run", "Report what would be redacted without writing anything")
        .option("--details", "List every redacted location (entry, path, kind)")
        .option(
            "--only <kinds>",
            "Redact only these kinds (comma-separated: password,secret,token,session,email,username,cookie,jwt)"
        )
        .option("--skip <kinds>", "Kinds to leave untouched (comma-separated)")
        .option(
            "--mask <overrides>",
            "Per-kind mask style, kind=style pairs (styles: label, stars, partial, keep). Example: --mask password=label,cookie=stars"
        )
        .action(
            async (
                files: string[],
                options: {
                    output?: string;
                    inPlace?: boolean;
                    dryRun?: boolean;
                    details?: boolean;
                    only?: string;
                    skip?: string;
                    mask?: string;
                }
            ) => {
                const parentOpts = program.opts<OutputOptions>();

                const { options: redactorOptions, errors: flagErrors } = parseRedactorFlags(options);
                if (flagErrors.length > 0) {
                    for (const error of flagErrors) {
                        out.error(error);
                    }
                    process.exit(1);
                }

                if (options.output && files.length > 1) {
                    out.error(
                        "--output works with a single input file. Use --in-place or the default *.redacted.har for batches."
                    );
                    process.exit(1);
                }

                if (options.output && options.inPlace) {
                    out.error("--output and --in-place are mutually exclusive.");
                    process.exit(1);
                }

                const backupDir = options.inPlace ? join("/tmp", `har-redact-backup-${Date.now()}`) : null;
                const reports: FileReport[] = [];

                for (const file of files) {
                    const inputPath = resolve(file);
                    let har: HarFile;
                    try {
                        har = await loadHarFile(inputPath);
                    } catch (err) {
                        logger.warn({ err, file: inputPath }, "[har-analyzer] redact: failed to parse HAR");
                        ui.err(`${inputPath}: not a parseable HAR file, skipping`);
                        continue;
                    }

                    const { har: redacted, changes, skipped } = redactHar(har, redactorOptions);

                    // Verification: a second pass over the redacted output must
                    // find nothing (the redactor is idempotent by design).
                    const secondPass = redactHar(redacted, redactorOptions);
                    const verified = secondPass.changes.length === 0;

                    let outputFile: string | null = null;
                    let backupFile: string | null = null;

                    if (!options.dryRun) {
                        const json = SafeJSON.stringify(redacted, { strict: true });

                        if (options.inPlace && backupDir) {
                            backupFile = join(backupDir, basename(inputPath));
                            await Bun.write(backupFile, Bun.file(inputPath));
                            await Bun.write(inputPath, json);
                            outputFile = inputPath;
                        } else if (options.output) {
                            outputFile = resolve(options.output);
                            await Bun.write(outputFile, json);
                        } else {
                            const base = basename(inputPath).replace(/\.har$/i, "");
                            outputFile = join(dirname(inputPath), `${base}.redacted.har`);
                            await Bun.write(outputFile, json);
                        }
                    }

                    reports.push({
                        file: inputPath,
                        outputFile,
                        backupFile,
                        entryCount: redacted.log.entries.length,
                        changeCount: changes.reduce((sum, c) => sum + c.count, 0),
                        changes,
                        skipped,
                        verified,
                    });
                }

                if (parentOpts.format === "json") {
                    out.result(SafeJSON.stringify(reports, { strict: true }));
                    return;
                }

                for (const report of reports) {
                    ui.header(basename(report.file));
                    ui.kv("entries", String(report.entryCount));
                    ui.kv("redactions", String(report.changeCount));

                    const byKind = summarizeByKind(report.changes);
                    for (const [kind, count] of [...byKind].sort((a, b) => b[1] - a[1])) {
                        ui.kv(`  ${kind}`, String(count));
                    }

                    for (const note of report.skipped) {
                        ui.warn(`  ${note}`);
                    }

                    if (report.verified) {
                        ui.ok("  verify: second pass found 0 remaining");
                    } else {
                        ui.err("  verify FAILED: second pass still found redactable data: do not trust this output");
                    }

                    if (options.details) {
                        printChangeDetail(report.changes);
                    }

                    if (report.outputFile) {
                        ui.info(`  -> ${report.outputFile}`);
                    } else {
                        ui.dim("  (dry run, nothing written)");
                    }
                }

                const inPlaceReports = reports.filter((r) => r.backupFile);
                if (inPlaceReports.length > 0) {
                    ui.section("Backups");
                    ui.warn(`Original contents were backed up before overwrite. Backups in ${backupDir}`);
                    ui.warn("/tmp is cleared on reboot, so the restore window is finite.");
                    ui.raw("# Restore (undo the redaction). Run if you want the originals back:");
                    for (const report of inPlaceReports) {
                        ui.raw(`cp "${report.backupFile}" "${report.file}"`);
                    }
                }

                const failed = reports.filter((r) => !r.verified);
                if (failed.length > 0) {
                    process.exit(1);
                }
            }
        );
}
