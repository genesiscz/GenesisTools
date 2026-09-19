import { selectedProvider } from "@genesiscz/utils/ai/evaluation/cli";
import { createEvaluator } from "@genesiscz/utils/ai/evaluation/service";
import { suggestEnumFlag } from "@genesiscz/utils/cli";
import { logger } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import { failPlain, printResult, withSigint } from "../lib/cli-output";
import { screenFiles } from "../lib/screen/batch";
import { parseCustomTemplates } from "../lib/screen/custom";
import { readScreenTargets } from "../lib/screen/files";
import { emitReport } from "../lib/screen/report";
import { listTemplates, PURPOSE_IDS, parsePurposes } from "../lib/screen/templates";

const DEFAULT_MAX_FILES = 30;

interface ScreenOptions {
    purpose?: string | boolean;
    list?: boolean;
    maxFiles: string;
    onlyChanged?: boolean;
    custom?: string;
    task?: string;
    sarif?: boolean;
    gate?: boolean;
    json?: boolean;
}

export function registerScreen(program: Command): void {
    program
        .command("screen")
        .description("Score files, a directory or a diff for a purpose class; never writes review comments")
        .argument("[path]", "File or directory to screen; omit or pass - to read stdin")
        .option("--purpose [ids]", "Purpose templates, comma separated")
        .option("--list", "List the purpose templates and their questions")
        .option("--max-files <n>", "Cap on files read from a directory", String(DEFAULT_MAX_FILES))
        .option("--only-changed", "Keep only paths that git diff --name-only reports")
        .option("--custom <file>", "JSON array of extra templates")
        .option("--task <text>", "Task description for the relevance template")
        .option("--sarif", "Write SARIF 2.1.0 instead of the default result")
        .option("--gate", "Exit 2 when a gate rule fires")
        .option("--json", "Keep the raw Jev evaluation payload in the result")
        .action(async (path: string | undefined, options: ScreenOptions) => {
            if (options.list) {
                printResult(listTemplates());
                return;
            }

            if (typeof options.purpose !== "string" || options.purpose.trim().length === 0) {
                failPlain(new Error(suggestEnumFlag("tools jev screen", "--purpose", PURPOSE_IDS)));
                return;
            }

            try {
                await runScreen(program, path, options);
            } catch (error) {
                failPlain(error, { command: "jev screen", path });
            }
        });
}

async function runScreen(program: Command, path: string | undefined, options: ScreenOptions): Promise<void> {
    const purposes = parsePurposes(typeof options.purpose === "string" ? options.purpose : undefined);
    const custom = options.custom ? parseCustomTemplates(await Bun.file(options.custom).text()) : undefined;
    const maxFiles = Number.parseInt(options.maxFiles, 10);

    if (!Number.isSafeInteger(maxFiles) || maxFiles < 1) {
        throw new Error(`--max-files must be a positive integer, got '${options.maxFiles}'.`);
    }

    logger.info(
        { path: path ?? "stdin", purposes: purposes.map((t) => t.id), maxFiles, onlyChanged: !!options.onlyChanged },
        "Starting jev screen"
    );
    const targets = await readScreenTargets({ path, maxFiles, onlyChanged: options.onlyChanged });
    const evaluate = await createEvaluator({ provider: selectedProvider(program) });
    const result = await withSigint((signal) =>
        screenFiles({ files: targets.files, purposes, custom, task: options.task, evaluate, signal })
    );
    emitReport({
        result: { ...result, source: targets.source, truncated: targets.truncated },
        gate: result.gate,
        subjects: result.scores.map((score) => ({ uri: score.file, document: score.answers, gate: score.gate })),
        purposes,
        custom,
        sarif: options.sarif,
        gateEnabled: options.gate,
        json: options.json,
    });
}
