import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import { withMeetingsClient } from "../lib/service/client";
import { fail } from "../lib/shared";

export function registerWordTimingCommands(program: Command): void {
    const group = program.command("word-timings").description("Generate cached local word timing evidence on demand");
    group
        .command("generate")
        .argument("<meeting>")
        .requiredOption("--from <seconds>")
        .requiredOption("--to <seconds>")
        .requiredOption("--model <id>", "already cached timestamp-enabled model")
        .option("--language <code>", "language hint; omitted lets the model detect it")
        .option("--json", "print coverage and provenance as JSON")
        .action(async (ref: string, options: { from: string; to: string; model: string; language?: string }) => {
            const controller = new AbortController();
            const cancel = () => controller.abort(new DOMException("Cancelled", "AbortError"));
            process.once("SIGINT", cancel);
            try {
                const result = await withMeetingsClient((client) =>
                    client.call(
                        "meeting.wordTimings.generate",
                        {
                            ref,
                            fromSec: Number(options.from),
                            toSec: Number(options.to),
                            model: options.model,
                            ...(options.language ? { language: options.language } : {}),
                        },
                        { signal: controller.signal, timeoutMs: 125_000 }
                    )
                );
                out.result(SafeJSON.stringify(result));
            } catch (error) {
                fail(error);
            } finally {
                process.off("SIGINT", cancel);
            }
        });
    group.command("_worker", { hidden: true }).action(async () => {
        try {
            const input = await Bun.stdin.text();
            if (input.length > 65_536) {
                throw new Error("Word timing worker input exceeds its budget");
            }
            const { runWordTimingWorker } = await import("../lib/word-timing-worker");
            out.result(SafeJSON.stringify(await runWordTimingWorker(SafeJSON.parse(input, { strict: true }))));
        } catch (error) {
            fail(error);
        }
    });
}
