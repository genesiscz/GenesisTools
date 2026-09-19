import { selectedProvider } from "@genesiscz/utils/ai/evaluation/cli";
import { createEvaluator, type Evaluator } from "@genesiscz/utils/ai/evaluation/service";
import { logger } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import { failPlain, printResult, withSigint } from "../lib/cli-output";
import { type CustomTemplate, parseCustomTemplates } from "../lib/screen/custom";
import { readScreenTargets } from "../lib/screen/files";
import { mergeGateVerdicts } from "../lib/screen/gate";
import { emitReport } from "../lib/screen/report";
import type { SarifSubject } from "../lib/screen/sarif";
import { DEFAULT_VERIFY_PURPOSES, listTemplates, type PurposeTemplate, parsePurposes } from "../lib/screen/templates";
import { type Claim, parseClaims, type VerifyResult, verifyClaims } from "../lib/screen/verify";

const DEFAULT_MAX_FILES = 30;

interface VerifyOptions {
    claims?: string;
    against?: string;
    againstDir?: string;
    maxFiles: string;
    purpose?: string | boolean;
    task?: string;
    custom?: string;
    onlyChanged?: boolean;
    list?: boolean;
    sarif?: boolean;
    gate?: boolean;
    json?: boolean;
}

export function registerVerify(program: Command): void {
    program
        .command("verify")
        .description("Judge claims against a document or a directory, plus purpose-template scores")
        .option("--claims <file>", "JSON array of {id,text}, a bullet list, or - for stdin")
        .option("--against <file>", "Document to judge, or - for stdin")
        .option("--against-dir <dir>", "Judge each file in a directory separately")
        .option("--max-files <n>", "Cap on files read from --against-dir", String(DEFAULT_MAX_FILES))
        .option("--purpose [ids]", "Purpose templates, comma separated")
        .option("--task <text>", "Task description for the relevance template")
        .option("--custom <file>", "JSON array of extra templates")
        .option("--only-changed", "Limit --against-dir to paths git diff --name-only reports")
        .option("--list", "List the purpose templates and their questions")
        .option("--sarif", "Write SARIF 2.1.0 instead of the default result")
        .option("--gate", "Exit 2 when a gate rule fires")
        .option("--json", "Keep the raw Jev evaluation payload in the result")
        .action(async (options: VerifyOptions) => {
            if (options.list) {
                printResult(listTemplates());
                return;
            }

            try {
                await runVerify(program, options);
            } catch (error) {
                failPlain(error, { command: "jev verify", against: options.against ?? options.againstDir });
            }
        });
}

async function runVerify(program: Command, options: VerifyOptions): Promise<void> {
    if (!options.claims) {
        throw new Error("verify needs --claims <file|->. Run tools jev verify --list to see the templates.");
    }

    if (!options.against && !options.againstDir) {
        throw new Error("verify needs --against <file|-> or --against-dir <dir>.");
    }

    const purposes = parsePurposes(
        typeof options.purpose === "string" ? options.purpose : undefined,
        DEFAULT_VERIFY_PURPOSES
    );
    const custom = options.custom ? parseCustomTemplates(await Bun.file(options.custom).text()) : undefined;
    const claimsText = options.claims === "-" ? await Bun.stdin.text() : await Bun.file(options.claims).text();
    const claims = parseClaims(claimsText);
    logger.info(
        {
            claims: claims.length,
            purposes: purposes.map((template) => template.id),
            against: options.against,
            againstDir: options.againstDir,
            onlyChanged: !!options.onlyChanged,
        },
        "Starting jev verify"
    );
    const evaluate = await createEvaluator({ provider: selectedProvider(program) });

    if (options.againstDir) {
        await verifyDirectory({ options, claims, purposes, custom, evaluate });
        return;
    }

    const uri = options.against === "-" ? "stdin" : (options.against as string);
    const against = options.against === "-" ? await Bun.stdin.text() : await Bun.file(uri).text();
    const result = await withSigint((signal) =>
        verifyClaims({ claims, against, purposes, custom, task: options.task, uri, evaluate, signal })
    );
    emitReport({
        result,
        gate: result.gate,
        subjects: [subjectOf(uri, result)],
        purposes,
        custom,
        sarif: options.sarif,
        gateEnabled: options.gate,
        json: options.json,
    });
}

async function verifyDirectory(input: {
    options: VerifyOptions;
    claims: Claim[];
    purposes: PurposeTemplate[];
    custom?: CustomTemplate[];
    evaluate: Evaluator;
}): Promise<void> {
    const { options, claims, purposes, custom, evaluate } = input;
    const maxFiles = Number.parseInt(options.maxFiles, 10);

    if (!Number.isSafeInteger(maxFiles) || maxFiles < 1) {
        throw new Error(`--max-files must be a positive integer, got '${options.maxFiles}'.`);
    }

    const targets = await readScreenTargets({
        path: options.againstDir,
        maxFiles,
        onlyChanged: options.onlyChanged,
    });
    const files: Array<{ file: string } & VerifyResult> = [];
    await withSigint(async (signal) => {
        for (const file of targets.files) {
            const result = await verifyClaims({
                claims,
                against: file.text,
                purposes,
                custom,
                task: options.task,
                uri: file.path,
                evaluate,
                signal,
            });
            files.push({ file: file.path, ...result });
        }
    });
    const gate = mergeGateVerdicts(files.map((entry) => entry.gate));
    emitReport({
        result: { files, truncated: targets.truncated, gate },
        gate,
        subjects: files.map((entry) => subjectOf(entry.file, entry)),
        purposes,
        custom,
        sarif: options.sarif,
        gateEnabled: options.gate,
        json: options.json,
    });
}

function subjectOf(uri: string, result: VerifyResult): SarifSubject {
    return { uri, document: result.document, gate: result.gate, claims: result.claims };
}
