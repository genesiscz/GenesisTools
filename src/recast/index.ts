#!/usr/bin/env bun
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { isInteractive, runTool, suggestEnumFlag, toolCommand } from "@genesiscz/utils/cli";
import { withInterrupt } from "@genesiscz/utils/cli/interrupt";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger, out } from "@genesiscz/utils/logger";
import { Command } from "commander";
import { previewCorrectionExamples } from "./lib/correction-examples";
import { defaultCollection, newRecastDocument, RECAST_LIMITS } from "./lib/document";
import { applyRecastOperation, recastOperationSchema } from "./lib/operations";
import { readRecastInput, verifyRecastAssets } from "./lib/package";
import { renderRecastCollection } from "./lib/render";
import { pendingReconciliationAnchors, recordIssues } from "./lib/validation";

const program = new Command("recast").description("Turn selected source material into reviewed, editable objects.");

async function enumeration<T extends string>({
    raw,
    values,
    flag,
    command,
}: {
    raw: string | true;
    values: readonly T[];
    flag: string;
    command: string;
}): Promise<T> {
    if (raw !== true && values.includes(raw as T)) {
        return raw as T;
    }
    if (raw === true && isInteractive()) {
        const prompts = await import("@clack/prompts");
        const value = await prompts.select<string>({
            message: flag,
            options: values.map((value) => ({ value: String(value), label: String(value) })),
        });
        if (!prompts.isCancel(value)) {
            return value as T;
        }
    }
    throw new Error(suggestEnumFlag(command, flag, values));
}

async function readJSON(filePath: string): Promise<unknown> {
    const file = Bun.file(filePath);
    if (file.size > RECAST_LIMITS.manifestBytes) {
        throw new Error("Recast JSON inputs may not exceed 32 MiB.");
    }
    logger.debug({ filePath, bytes: file.size }, "recast: reading operation input");
    return SafeJSON.parse(await file.text(), { strict: true });
}

async function openRecast({
    filePath,
    reviewCSVPath,
}: {
    filePath?: string;
    reviewCSVPath?: string;
} = {}): Promise<void> {
    if (reviewCSVPath && !filePath) {
        throw new Error("Choose a Recast conversion with --review-csv.");
    }
    const { appStatus, buildApp } = await import("@app/macos/lib/permissions/app");
    const status = appStatus();
    if (!status.built || status.stale || !status.manifest) {
        await buildApp({ onStep: (message) => out.log.info(message) });
    }

    const args = [
        "/usr/bin/open",
        "-n",
        status.bundlePath,
        "--args",
        "--recast",
        "--tools",
        resolve(import.meta.dirname, "../../tools"),
        "--directory",
        process.cwd(),
    ];
    if (filePath) {
        args.push("--open", resolve(filePath));
    }
    if (reviewCSVPath) {
        args.push("--review-csv", resolve(reviewCSVPath));
    }
    logger.debug({ args }, "recast: opening native conversion window");
    const child = Bun.spawn(args, { stdout: "pipe", stderr: "pipe", signal: AbortSignal.timeout(10000) });
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    if (code !== 0) {
        throw new Error(`Recast did not open: ${stderr}`);
    }
    out.result({ opened: true, file: filePath ?? null });
}

program.action(() => openRecast());
program
    .command("open")
    .argument("[file]", "Recast document package")
    .option("--review-csv <file>", "Open an edited CSV in the native review sheet without applying it")
    .action((filePath: string | undefined, options: { reviewCsv?: string }) =>
        openRecast({ filePath, reviewCSVPath: options.reviewCsv })
    );

program
    .command("new")
    .option("--title <title>", "Conversion title", "Untitled conversion")
    .option("--kind [kind]", "table, checklist, or calendar", "table")
    .action(async (options: { title: string; kind: string | true }) => {
        const kind = await enumeration({
            raw: options.kind,
            values: ["table", "checklist", "calendar"] as const,
            flag: "--kind",
            command: toolCommand("recast new"),
        });
        const document = newRecastDocument({ title: options.title });
        document.collections = [defaultCollection(kind)];
        out.result(document);
    });

program
    .command("inspect")
    .requiredOption("--input <file>", "Manifest JSON or Recast package")
    .option("--verify-assets", "Verify every source snapshot in a package")
    .action(async (options: { input: string; verifyAssets?: boolean }) => {
        const { document, packagePath } = await readRecastInput(options.input);
        if (options.verifyAssets) {
            if (!packagePath) {
                throw new Error("Asset verification needs a .recast package directory.");
            }
            await withInterrupt((signal) => verifyRecastAssets({ document, packagePath, signal }));
        }
        const pendingAnchors = pendingReconciliationAnchors(document);
        out.result({
            document,
            issues: document.records
                .filter((record) => record.state !== "archived")
                .flatMap((record) => recordIssues({ document, record, pendingAnchors })),
            assetsVerified: Boolean(options.verifyAssets),
        });
    });

program
    .command("correction-examples")
    .description("Inspect source-local human correction examples without changing the conversion")
    .requiredOption("--input <file>", "Manifest JSON or Recast package")
    .requiredOption("--record <id>", "Current record")
    .requiredOption("--field <id>", "Current field")
    .action(async (options: { input: string; record: string; field: string }) => {
        const { document } = await readRecastInput(options.input);
        out.result(previewCorrectionExamples({ input: document, recordId: options.record, fieldId: options.field }));
    });

program
    .command("apply")
    .requiredOption("--input <file>", "Manifest JSON or Recast package")
    .requiredOption("--operation <file>", "Operation JSON")
    .requiredOption("--revision <number>", "Expected document revision")
    .action(async (options: { input: string; operation: string; revision: string }) => {
        const { document } = await readRecastInput(options.input);
        const input = await readJSON(options.operation);
        const operations = Array.isArray(input) ? input : [input];
        if (operations.length < 1 || operations.length > 64) {
            throw new Error("Apply between 1 and 64 operations in one transaction.");
        }

        let result = document;
        let expectedRevision = Number(options.revision);
        for (const rawOperation of operations) {
            const operation = recastOperationSchema.parse(rawOperation);
            result = applyRecastOperation({ input: result, expectedRevision, operation });
            expectedRevision = result.revision;
        }
        out.result(result);
    });

program
    .command("render")
    .requiredOption("--input <file>", "Manifest JSON or Recast package")
    .requiredOption("--collection <id>", "Object collection")
    .option("--format [format]", "csv, markdown, json, or ics", "csv")
    .option("--records <ids>", "Comma-separated selection; otherwise every active record")
    .option("--output <file>", "Create one output file without replacing existing content")
    .option("--evidence", "Write the evidence report instead of the destination rendering")
    .option("--no-record-ids", "Omit stable row IDs from CSV")
    .action(
        async (options: {
            input: string;
            collection: string;
            format: string | true;
            records?: string;
            output?: string;
            evidence?: boolean;
            recordIds: boolean;
        }) => {
            const format = await enumeration({
                raw: options.format,
                values: ["csv", "markdown", "json", "ics"] as const,
                flag: "--format",
                command: toolCommand("recast render"),
            });
            const { document, packagePath } = await readRecastInput(options.input);
            if (packagePath) {
                await withInterrupt((signal) => verifyRecastAssets({ document, packagePath, signal }));
            }
            const rendering = renderRecastCollection({
                input: document,
                collectionId: options.collection,
                format,
                recordIds: options.records?.split(",").filter(Boolean),
                includeRecordIds: options.recordIds,
            });
            if (options.output) {
                const content = options.evidence ? rendering.evidence : rendering.text;
                await writeFile(options.output, content, { flag: "wx" });
                logger.debug(
                    { output: options.output, bytes: Buffer.byteLength(content), format },
                    "recast: exported reviewed objects"
                );
                out.result({
                    output: options.output,
                    records: rendering.recordIds.length,
                    format: options.evidence ? "evidence" : format,
                });
            } else {
                out.result(rendering);
            }
        }
    );

program
    .command("reconcile")
    .requiredOption("--input <file>", "Manifest JSON or Recast package")
    .requiredOption("--old <id>", "Original source snapshot")
    .requiredOption("--new <id>", "Replacement source snapshot")
    .option("--job <id>", "Existing source review, including resolved decisions")
    .action(async (options: { input: string; old: string; new: string; job?: string }) => {
        const { document } = await readRecastInput(options.input);
        const { previewReconciliation } = await import("./lib/reconcile");
        out.result(
            previewReconciliation({
                input: document,
                oldSourceId: options.old,
                newSourceId: options.new,
                jobId: options.job,
            })
        );
    });

program
    .command("roundtrip")
    .requiredOption("--input <file>", "Manifest JSON or Recast package")
    .requiredOption("--receipt <id>", "Saved CSV export receipt")
    .requiredOption("--csv <file>", "Edited CSV to compare; this command changes nothing")
    .action(async (options: { input: string; receipt: string; csv: string }) => {
        const { document } = await readRecastInput(options.input);
        const csv = Bun.file(options.csv);
        if (csv.size > 16 * 1024 * 1024) {
            throw new Error("CSV re-import supports files no larger than 16 MiB.");
        }
        const { previewRoundTrip } = await import("./lib/roundtrip");
        logger.debug(
            { filePath: options.csv, bytes: csv.size, receiptId: options.receipt },
            "recast: comparing destination edits"
        );
        out.result(previewRoundTrip({ input: document, receiptId: options.receipt, csv: await csv.text() }));
    });

program
    .command("transcription-choices")
    .description("Read configured transcription-capable accounts without binding or refreshing credentials")
    .action(async () => {
        const { listTaskAccountChoices } = await import("@genesiscz/utils/ai/tasks/choices");
        out.result(await listTaskAccountChoices("transcribe"));
    });

program
    .command("transcribe")
    .requiredOption("--input <file>", "Manifest JSON or Recast package")
    .requiredOption("--source <id>", "Preserved audio source")
    .requiredOption("--audio <file>", "Local copy of the preserved source bytes")
    .requiredOption("--start-ms <number>", "Beginning of the selected source interval")
    .requiredOption("--end-ms <number>", "End of the selected source interval")
    .option("--model <id>", "Transcription binding; otherwise the Recast app default")
    .option("--language <code>", "Optional spoken language code")
    .action(
        async (options: {
            input: string;
            source: string;
            audio: string;
            startMs: string;
            endMs: string;
            model?: string;
            language?: string;
        }) => {
            const { document } = await readRecastInput(options.input);
            const { transcribeRecastSelection } = await import("./lib/transcription-generation");
            const review = await withInterrupt(
                (signal) =>
                    transcribeRecastSelection({
                        input: document,
                        sourceId: options.source,
                        audioPath: options.audio,
                        startMs: Number(options.startMs),
                        endMs: Number(options.endMs),
                        model: options.model,
                        language: options.language,
                        signal,
                    }),
                { handleTermination: true }
            );
            out.result(review);
        }
    );

program
    .command("capture-transcript")
    .requiredOption("--input <file>", "Manifest JSON or Recast package")
    .requiredOption("--review <file>", "Transcript review JSON")
    .requiredOption("--collection <id>", "Destination collection")
    .option("--mode [mode]", "readings, rows, or field", "readings")
    .option("--record <id>", "Destination record for field mode")
    .option("--field <id>", "Destination field for field mode")
    .action(
        async (options: {
            input: string;
            review: string;
            collection: string;
            mode: string | true;
            record?: string;
            field?: string;
        }) => {
            const { document } = await readRecastInput(options.input);
            const { captureRecastTranscript } = await import("./lib/transcription");
            const mode = await enumeration({
                raw: options.mode,
                values: ["readings", "rows", "field"] as const,
                flag: "--mode",
                command: toolCommand("recast capture-transcript"),
            });
            out.result(
                captureRecastTranscript({
                    input: document,
                    review: await readJSON(options.review),
                    collectionId: options.collection,
                    mode,
                    recordId: options.record,
                    fieldId: options.field,
                })
            );
        }
    );

program
    .command("proposal-choices")
    .description("Read configured chat-capable accounts without binding or refreshing credentials")
    .action(async () => {
        const { listTaskAccountChoices } = await import("@genesiscz/utils/ai/tasks/choices");
        out.result(await listTaskAccountChoices("chat"));
    });

program
    .command("proposal-context")
    .description("Preview exactly which saved readings and collection fields would be sent, without an AI call")
    .requiredOption("--input <file>", "Manifest JSON or Recast package")
    .requiredOption("--collection <id>", "Destination collection")
    .requiredOption("--readings <ids>", "Explicit comma-separated reading IDs, at most 200")
    .action(async (options: { input: string; collection: string; readings: string }) => {
        const { document } = await readRecastInput(options.input);
        const { previewRecastProposalInput } = await import("./lib/proposals");
        out.result(
            previewRecastProposalInput({
                input: document,
                collectionId: options.collection,
                readingIds: options.readings.split(","),
            })
        );
    });

program
    .command("propose")
    .requiredOption("--input <file>", "Manifest JSON or Recast package")
    .requiredOption("--collection <id>", "Destination collection")
    .requiredOption("--readings <ids>", "Explicit comma-separated reading IDs, at most 200")
    .requiredOption("--instruction <text>", "What objects to extract")
    .option("--model <id>", "Existing AI model binding; otherwise the Recast app default")
    .action(
        async (options: {
            input: string;
            collection: string;
            readings: string;
            instruction: string;
            model?: string;
        }) => {
            const { document } = await readRecastInput(options.input);
            const { generateRecastProposal } = await import("./lib/proposal-generation");
            const proposal = await withInterrupt(
                (signal) =>
                    generateRecastProposal({
                        input: document,
                        collectionId: options.collection,
                        readingIds: options.readings.split(","),
                        instruction: options.instruction,
                        model: options.model,
                        signal,
                    }),
                { handleTermination: true }
            );
            out.result(proposal);
        }
    );

try {
    await runTool(program, { tool: "recast" });
} catch (error) {
    logger.error({ error }, "recast: command failed");
    out.result({ error: error instanceof Error ? error.message : String(error) });
    process.exitCode = 1;
}
