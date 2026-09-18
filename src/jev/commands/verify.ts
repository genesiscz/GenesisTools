import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { selectedProvider } from "@genesiscz/utils/ai/evaluation/cli";
import { createEvaluator } from "@genesiscz/utils/ai/evaluation/service";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import { z } from "zod";
import { claimSchema, parseTemplates, VERIFY_TEMPLATES, verifyClaims } from "../lib/verify-claims";
import { customTemplateSchema, listFiles, toSarif } from "../lib/verify-sarif";

export function registerVerify(program: Command): void {
    program
        .command("verify")
        .description("Judge claims against text with predefined purpose templates")
        .option("--claims <file>", "JSON array of {id,text}")
        .option("--against <file>", "Document to judge, or - for stdin")
        .option("--against-dir <dir>", "Verify each file separately, max --max-files")
        .option("--max-files <n>", "Directory cap", "30")
        .option("--purpose <list>", "Comma-separated templates")
        .option("--task <text>", "Relevance task")
        .option("--templates", "Print builtin templates and exit")
        .option("--custom <file>", "User templates JSON")
        .option("--sarif", "Write SARIF instead of the default JSON")
        .option("--gate", "Exit 2 when secrets/injection/risk gates fire")
        .action(
            async (options: {
                claims?: string;
                against?: string;
                againstDir?: string;
                maxFiles: string;
                purpose?: string;
                task?: string;
                templates?: boolean;
                custom?: string;
                sarif?: boolean;
                gate?: boolean;
            }) => {
                if (options.templates) {
                    out.result({ templates: VERIFY_TEMPLATES });
                    return;
                }
                if (!options.claims || (!options.against && !options.againstDir)) {
                    throw new Error("Pass --claims and --against or --against-dir, or --templates.");
                }
                const claims = z
                    .array(claimSchema)
                    .parse(
                        SafeJSON.parse(
                            options.claims === "-" ? await Bun.stdin.text() : await Bun.file(options.claims).text()
                        )
                    );
                const custom = options.custom
                    ? z.array(customTemplateSchema).parse(SafeJSON.parse(await Bun.file(options.custom).text()))
                    : undefined;
                const evaluate = await createEvaluator({ provider: selectedProvider(program) });
                if (options.againstDir) {
                    const names = (await readdir(options.againstDir)).filter((name) => !name.startsWith("."));
                    const listed = listFiles(
                        names.map((name) => join(options.againstDir as string, name)),
                        Number(options.maxFiles)
                    );
                    if (listed.remainder) {
                        throw new Error(
                            `--against-dir has ${listed.remainder} files over --max-files ${options.maxFiles}.`
                        );
                    }
                    const files = [];
                    for (const file of listed.files) {
                        const against = await Bun.file(file).text();
                        files.push({
                            file,
                            ...(await verifyClaims({
                                against,
                                claims,
                                purposes: parseTemplates(options.purpose),
                                task: options.task,
                                evaluate,
                                custom,
                            })),
                        });
                    }
                    out.result({ files });
                    return;
                }
                const against =
                    options.against === "-" ? await Bun.stdin.text() : await Bun.file(options.against as string).text();
                const result = await verifyClaims({
                    against,
                    claims,
                    purposes: parseTemplates(options.purpose),
                    task: options.task,
                    evaluate,
                    custom,
                });
                if (options.sarif) {
                    out.result(
                        toSarif({ document: result.document, gate: result.gate, uri: options.against ?? "stdin" })
                    );
                } else {
                    out.result({ document: result.document, claims: result.claims, gate: result.gate });
                }
                if (options.gate && result.gate.block) {
                    process.exitCode = 2;
                }
            }
        );
}
