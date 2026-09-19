import { selectedProvider } from "@genesiscz/utils/ai/evaluation/cli";
import { evaluateRequest } from "@genesiscz/utils/ai/evaluation/service";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import { fillForm } from "../lib/decision/fill";
import { type ControlOptions, controlDriver, observationOptions } from "./decision";

export function registerFillCommand(program: Command) {
    observationOptions(
        program.command("fill").description("Fill named string values, verify exact readback, never submit")
    )
        .requiredOption("--data <file>", "JSON object of supplied field names and exact string values")
        .option("--max-requests <n>", "Maximum model requests", "20")
        .option("--max-fields <n>", "Maximum write attempts", "20")
        .action(async (options: ControlOptions & { data: string; maxRequests: string; maxFields: string }) => {
            const data = SafeJSON.parse(await Bun.file(options.data).text());
            const controller = new AbortController();
            const cancel = () => controller.abort();
            process.once("SIGINT", cancel);
            try {
                const result = await fillForm({
                    data,
                    driver: controlDriver(options),
                    signal: controller.signal,
                    limits: {
                        timeoutMs: Number(options.timeout),
                        maxRequests: Number(options.maxRequests),
                        maxActions: Number(options.maxFields),
                    },
                    evaluate: (call) => evaluateRequest({ ...call, provider: selectedProvider(program) }),
                });
                out.result(result);
                if (result.status !== "filled") {
                    process.exitCode = 1;
                }
            } finally {
                process.off("SIGINT", cancel);
            }
        });
}
