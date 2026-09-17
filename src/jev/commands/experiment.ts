import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import { compileExperiment } from "../lib/compiler";
import { runExperiment, stepExperiment } from "../lib/experiment";
import { experimentRequestSchema } from "../lib/experiment-contract";
import { generationMode } from "../lib/generation";
import { languages } from "../lib/languages";
import { typescriptPresets } from "../lib/typescript-grammar";
import { readInput } from "./evaluate";

export function registerExperiment(program: Command): void {
    const lab = program
        .command("experiment")
        .aliases(["typescript", "ts"])
        .description("Build programs through constrained-token or free-character decisions");
    lab.command("example")
        .description("Print an editable TypeScript experiment request")
        .option("--characters", "Use character choices without a string vocabulary or grammar filter")
        .action((options: { characters?: boolean }) => {
            const { name, ...preset } = typescriptPresets[0];
            out.result(
                experimentRequestSchema.parse({
                    ...preset,
                    ...(options.characters ? { mode: "characters", literals: [], maxSteps: 256 } : {}),
                })
            );
        });
    lab.command("state")
        .argument("<file>")
        .description("Inspect source and next choices without calling Jev")
        .action(async (file: string) => {
            const request = experimentRequestSchema.parse(await readInput(file));
            out.result(generationMode(request.mode).state(languages.get(request.language), request));
        });
    lab.command("step")
        .argument("<file>")
        .description("Ask Jev to choose one next token")
        .action(async (file: string) => out.result(await stepExperiment({ input: await readInput(file) })));
    lab.command("run")
        .argument("<file>")
        .description("Run up to maxSteps; emit each decision as JSON")
        .action(async (file: string) => {
            const controller = new AbortController();
            const cancel = () => controller.abort();
            process.once("SIGINT", cancel);
            try {
                for await (const step of runExperiment({ input: await readInput(file), signal: controller.signal })) {
                    out.result(step);
                }
            } finally {
                process.off("SIGINT", cancel);
            }
        });
    lab.command("compile")
        .argument("<file>")
        .description("Replay, compile and run a completed experiment")
        .action(async (file: string) => out.result(await compileExperiment({ input: await readInput(file) })));
}
