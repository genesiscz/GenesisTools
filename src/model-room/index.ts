import { resolve } from "node:path";
import * as prompts from "@clack/prompts";
import { isInteractive, runTool, suggestEnumFlag } from "@genesiscz/utils/cli";
import { withInterrupt } from "@genesiscz/utils/cli/interrupt";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger, out } from "@genesiscz/utils/logger";
import { Command } from "commander";
import { compileModel } from "./lib/compiler";
import { importObservationQuantity, previewObservationTable, verifyObservationDigest } from "./lib/data-import";
import { readModelDocument } from "./lib/document";
import { evaluateDocument } from "./lib/evaluation";
import { classroomModel, projectBudgetModel, supportCapacityModel } from "./lib/examples";
import { assumptionsCSV, resultsCSV } from "./lib/exports";
import { standaloneModelHTML } from "./lib/html-export";
import { sweepModel } from "./lib/simulation";
import { readSweepConfiguration } from "./lib/sweep";

const program = new Command("model-room").description("Create and evaluate local, unit-aware system models.");

async function readInput(filePath: string) {
    const file = Bun.file(filePath);
    logger.debug({ filePath, bytes: file.size }, "model-room: reading model document");

    if (file.size > 16 * 1024 * 1024) {
        throw new Error("Model documents may not exceed 16 MiB.");
    }

    const input: unknown = SafeJSON.parse(await file.text(), { strict: true });
    return readModelDocument(input);
}

async function openNativeModel({ filePath, dataPath }: { filePath?: string; dataPath?: string } = {}): Promise<void> {
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
        "--model-room",
        "--tools",
        resolve(import.meta.dirname, "../../tools"),
        "--directory",
        process.cwd(),
    ];

    if (filePath) {
        args.push("--open", resolve(filePath));
    }

    if (dataPath) {
        args.push("--data", resolve(dataPath));
    }

    logger.debug({ args }, "model-room: opening native document window");
    const child = Bun.spawn(args, { stdout: "pipe", stderr: "pipe", signal: AbortSignal.timeout(10000) });
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);

    if (code !== 0) {
        throw new Error(`Could not open Model Room: ${stderr}`);
    }

    out.result({ opened: true, file: filePath ? resolve(filePath) : null });
}

program.action(() => openNativeModel());
program
    .command("open")
    .description("Open the native Model Room window, building the signed app when needed.")
    .argument("[file]", "Existing model document")
    .option("--data <file>", "Open the native observation-mapping sheet for this CSV or TSV")
    .action((filePath: string | undefined, options: { data?: string }) =>
        openNativeModel({ filePath, dataPath: options.data })
    );

async function readTable(filePath: string): Promise<string> {
    const file = Bun.file(filePath);
    logger.debug({ filePath, bytes: file.size }, "model-room: reading observation table");

    if (file.size > 16 * 1024 * 1024) {
        throw new Error("Observation tables may not exceed 16 MiB.");
    }

    return file.text();
}

async function choice<T extends string>({
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
    const found = values.find((value) => value === raw);

    if (found !== undefined) {
        return found;
    }

    if (raw === true && isInteractive()) {
        const selected = await prompts.select<string>({
            message: `Choose ${flag}`,
            options: values.map((value) => ({ value, label: value })),
        });

        if (prompts.isCancel(selected)) {
            throw new Error("Selection cancelled.");
        }

        const chosen = values.find((value) => value === selected);

        if (chosen !== undefined) {
            return chosen;
        }
    }

    throw new Error(suggestEnumFlag(command, flag, values, { given: typeof raw === "string" ? raw : undefined }));
}

async function delimiterArgument(raw: string | true, command: string): Promise<"," | ";" | "\t"> {
    const value = await choice({ raw, command, flag: "--delimiter", values: ["comma", "semicolon", "tab"] as const });
    if (value === "comma") {
        return ",";
    }

    if (value === "semicolon") {
        return ";";
    }

    if (value === "tab") {
        return "\t";
    }

    throw new Error("Choose a delimiter: comma, semicolon, or tab.");
}

program
    .command("inspect-table")
    .description("Preview an observation table without changing it.")
    .requiredOption("--data <file>", "CSV or TSV table")
    .option("--delimiter [delimiter]", "comma, semicolon, or tab", "comma")
    .action(async (options: { data: string; delimiter: string | true }) => {
        const delimiter = await delimiterArgument(options.delimiter, "tools model-room inspect-table");
        const text = await readTable(options.data);
        out.result({
            ...previewObservationTable({ text, delimiter }),
            sha256: await verifyObservationDigest({ text }),
        });
    });

program
    .command("import-data")
    .description("Print a new model revision with mapped observations, leaving both input files untouched.")
    .requiredOption("--input <file>", "Model document")
    .requiredOption("--data <file>", "CSV or TSV observations")
    .option("--expected-sha256 <digest>", "Require the exact observation revision shown in a prior preview")
    .requiredOption("--time-column <name>", "Column containing numeric model time")
    .requiredOption("--value-column <name>", "Column containing observed values")
    .requiredOption("--id <identifier>", "Unique quantity identifier")
    .requiredOption("--label <text>", "Readable quantity name")
    .requiredOption("--unit <unit>", "Unit of observed values")
    .option("--delimiter [delimiter]", "comma, semicolon, or tab", "comma")
    .option("--interpolation [mode]", "hold or linear", "hold")
    .option("--decimal [separator]", "dot or comma", "dot")
    .action(
        async (options: {
            input: string;
            data: string;
            timeColumn: string;
            valueColumn: string;
            expectedSha256?: string;
            id: string;
            label: string;
            unit: string;
            delimiter: string | true;
            interpolation: string | true;
            decimal: string | true;
        }) => {
            const command = "tools model-room import-data";
            const delimiter = await delimiterArgument(options.delimiter, command);
            const interpolation = await choice({
                raw: options.interpolation,
                command,
                flag: "--interpolation",
                values: ["hold", "linear"] as const,
            });
            const decimal = await choice({
                raw: options.decimal,
                command,
                flag: "--decimal",
                values: ["dot", "comma"] as const,
            });

            const document = await readInput(options.input);
            const text = await readTable(options.data);
            await verifyObservationDigest({ text, expectedDigest: options.expectedSha256 });
            const imported = importObservationQuantity({
                document,
                text,
                id: options.id,
                label: options.label,
                unit: options.unit,
                sourceName: options.data.split(/[\\/]/).pop() ?? "Imported table",
                mapping: {
                    timeColumn: options.timeColumn,
                    valueColumn: options.valueColumn,
                    delimiter,
                    interpolation,
                    decimalSeparator: decimal === "dot" ? "." : ",",
                },
            });
            out.result(imported);
        }
    );

program
    .command("example")
    .description("Print an editable example model as JSON.")
    .argument("[name]", "support, classroom, or budget", "support")
    .action((name: string) => {
        const model =
            name === "support"
                ? supportCapacityModel()
                : name === "classroom"
                  ? classroomModel()
                  : name === "budget"
                    ? projectBudgetModel()
                    : undefined;

        if (!model) {
            throw new Error("Choose an example: support, classroom, or budget.");
        }

        out.result(model);
    });

program
    .command("evaluate")
    .description("Evaluate every scenario; invalid scenario branches retain a diagnostic alongside valid results.")
    .requiredOption("--input <file>", "Model Room JSON document")
    .action(async (options: { input: string }) => {
        const document = await readInput(options.input);
        logger.debug(
            { quantities: document.quantities.length, scenarios: document.scenarios.length },
            "model-room: evaluate"
        );
        const result = await evaluateDocument({ input: document });
        out.result(result);
    });

program
    .command("sweep")
    .description("Explore bounded input ranges; completed runs survive cancellation.")
    .requiredOption("--input <file>", "Model document")
    .requiredOption("--config <file>", "JSON with axes, output identifiers and optional scenarioId")
    .option("--stream", "Emit JSON lines and cancel when the controlling stdin pipe closes")
    .action(async (options: { input: string; config: string; stream?: boolean }) => {
        const document = await readInput(options.input);
        const configuration = readSweepConfiguration(SafeJSON.parse(await readTable(options.config), { strict: true }));
        logger.debug({ runs: configuration.total, axes: configuration.axes.length }, "model-room: starting sweep");
        const lifetime = new AbortController();
        const end = () => lifetime.abort();
        process.on("SIGTERM", end);

        if (options.stream) {
            process.stdin.on("end", end);
            process.stdin.resume();
            out.result({ event: "start", total: configuration.total });
        }

        try {
            const result = await withInterrupt((signal) =>
                sweepModel({
                    document,
                    axes: configuration.axes,
                    outputs: configuration.outputs,
                    scenarioId: configuration.scenarioId,
                    control: { signal: AbortSignal.any([signal, lifetime.signal]) },
                    onRun: options.stream
                        ? (run, completed) => out.result({ event: "run", run, completed })
                        : undefined,
                })
            );
            logger.debug({ status: result.status, completed: result.runs.length }, "model-room: sweep ended");
            out.result(
                options.stream
                    ? { event: "end", status: result.status, completed: result.runs.length, total: result.total }
                    : result
            );
        } finally {
            process.off("SIGTERM", end);
            process.stdin.off("end", end);

            if (options.stream) {
                process.stdin.pause();
            }
        }
    });

program
    .command("validate")
    .description("Check the schema, dimensions, references and cycles without changing the document.")
    .requiredOption("--input <file>", "Model Room JSON document")
    .action(async (options: { input: string }) => {
        const document = await readInput(options.input);
        const baseline = compileModel({ input: document });
        document.scenarios.forEach((scenario) => {
            compileModel({ input: document, scenarioId: scenario.id });
        });
        out.result({
            valid: true,
            quantities: baseline.quantities.size,
            steps: baseline.steps,
            scenarios: document.scenarios.length,
        });
    });

program
    .command("export")
    .description("Export a standalone offline HTML model or a CSV table.")
    .requiredOption("--input <file>", "Model Room JSON document")
    .requiredOption("--output <file>", "Destination file, created without replacing an existing file")
    .option("--format [format]", "html, results, or assumptions", "html")
    .action(async (options: { input: string; output: string; format: string | true }) => {
        const format = await choice({
            raw: options.format,
            command: "tools model-room export",
            flag: "--format",
            values: ["html", "results", "assumptions"] as const,
        });
        const document = await readInput(options.input);
        let text: string;

        if (format === "html") {
            text = await standaloneModelHTML(document);
        } else if (format === "results") {
            const evaluation = await evaluateDocument({ input: document });
            text = resultsCSV(document, evaluation.scenarios);
        } else if (format === "assumptions") {
            text = assumptionsCSV(document);
        } else {
            throw new Error("Choose an export format: html, results, or assumptions.");
        }

        const { writeFile } = await import("node:fs/promises");
        await writeFile(options.output, text, { flag: "wx" });
        logger.debug(
            { destination: options.output, bytes: Buffer.byteLength(text), format },
            "model-room: exported model"
        );
        out.result({ output: options.output, format, bytes: Buffer.byteLength(text) });
    });

try {
    await runTool(program, { tool: "model-room" });
} catch (error) {
    logger.error({ error }, "model-room: command failed");
    out.result({ error: error instanceof Error ? error.message : String(error) });
    process.exitCode = 1;
}
