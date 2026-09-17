import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import { demoInput } from "../lib/evaluate";
import { evaluateRequest, gatewayStatus } from "../lib/service";

interface Options {
    timeout: string;
    zdr?: boolean;
}

export async function readInput(file: string): Promise<unknown> {
    if (file === "-" && process.stdin.isTTY) {
        throw new Error("Pipe JSON into stdin when using -.");
    }

    return SafeJSON.parse(file === "-" ? await Bun.stdin.text() : await Bun.file(file).text());
}

function evaluationOptions(command: Command): Command {
    return command
        .option("--timeout <ms>", "Request deadline in milliseconds", "30000")
        .option("--zdr", "Require Zero Data Retention (Vercel Pro or Enterprise)");
}

async function run(input: unknown, options: Options): Promise<void> {
    const timeoutMs = Number(options.timeout);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000) {
        throw new Error("--timeout must be an integer from 1 to 300000 milliseconds.");
    }

    out.result(await evaluateRequest({ input, timeoutMs, zeroDataRetention: options.zdr }));
}

export function registerEvaluation(program: Command): void {
    evaluationOptions(
        program
            .command("demo")
            .description("Evaluate a sample with all three question types")
            .option("--example", "Print input JSON without a model call")
    ).action(async (options: Options & { example?: boolean }) => {
        if (options.example) {
            out.result(demoInput);
            return;
        }

        await run(demoInput, options);
    });
    evaluationOptions(
        program
            .command("ask")
            .description("Evaluate a boolean question")
            .argument("<question>", "Question to evaluate")
            .option("--state <text>", "Text to evaluate; otherwise stdin")
    ).action(async (question: string, options: Options & { state?: string }) => {
        if (options.state === undefined && process.stdin.isTTY) {
            throw new Error("Provide --state or pipe text into tools jev ask.");
        }

        const state = options.state ?? (await Bun.stdin.text());
        await run({ state, questions: { answer: { type: "boolean", instructions: question } } }, options);
    });
    evaluationOptions(
        program
            .command("run")
            .description("Evaluate a JSON/JSONC request")
            .argument("<file>", "Input file or - for stdin")
    ).action(async (file: string, options: Options) => run(await readInput(file), options));
    program
        .command("status")
        .description("Read credential availability and gateway credit balance")
        .action(async () => out.result(await gatewayStatus()));
}
