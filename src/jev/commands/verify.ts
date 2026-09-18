import { selectedProvider } from "@genesiscz/utils/ai/evaluation/cli";
import { createEvaluator } from "@genesiscz/utils/ai/evaluation/service";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import { z } from "zod";
import { claimSchema, parseTemplates, VERIFY_TEMPLATES, verifyClaims } from "../lib/verify-claims";

export function registerVerify(program: Command): void {
    program
        .command("verify")
        .description("Judge claims against text with predefined purpose templates")
        .option("--claims <file>", "JSON array of {id,text}")
        .option("--against <file>", "Document to judge, or - for stdin")
        .option("--purpose <list>", "Comma-separated templates")
        .option("--task <text>", "Relevance task")
        .option("--templates", "Print builtin templates and exit")
        .option("--gate", "Exit 2 when secrets/injection/risk gates fire")
        .action(
            async (options: {
                claims?: string;
                against?: string;
                purpose?: string;
                task?: string;
                templates?: boolean;
                gate?: boolean;
            }) => {
                if (options.templates) {
                    out.result({ templates: VERIFY_TEMPLATES });
                    return;
                }
                if (!options.claims || !options.against) {
                    throw new Error("Pass --claims and --against, or --templates.");
                }
                const claims = z
                    .array(claimSchema)
                    .parse(
                        SafeJSON.parse(
                            options.claims === "-" ? await Bun.stdin.text() : await Bun.file(options.claims).text()
                        )
                    );
                const against =
                    options.against === "-" ? await Bun.stdin.text() : await Bun.file(options.against).text();
                const result = await verifyClaims({
                    against,
                    claims,
                    purposes: parseTemplates(options.purpose),
                    task: options.task,
                    evaluate: await createEvaluator({ provider: selectedProvider(program) }),
                });
                out.result({ document: result.document, claims: result.claims, gate: result.gate });
                if (options.gate && result.gate.block) {
                    process.exitCode = 2;
                }
            }
        );
}
