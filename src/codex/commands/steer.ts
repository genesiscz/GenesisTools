import { readFileSync } from "node:fs";
import { SafeJSON } from "@app/utils/json";
import { out } from "@app/utils/logger";
import type { Command } from "commander";
import { sendControlRequest } from "../lib/control-channel";

export function registerSteerCommand(program: Command): void {
    program
        .command("steer")
        .description("Inject input into a running Codex turn")
        .requiredOption("--name <name>", "Session name")
        .option("--body <text>", "Steering message")
        .option("--body-file <path>", "Read steering message from a file")
        .option("--force", "Interrupt then start if same-turn steering is rejected")
        .action(async (options: { name: string; body?: string; bodyFile?: string; force?: boolean }) => {
            if (options.body && options.bodyFile) {
                throw new Error("--body and --body-file are mutually exclusive");
            }

            const body = options.bodyFile ? readFileSync(options.bodyFile, "utf8") : options.body;
            if (!body) {
                throw new Error("--body or --body-file is required");
            }

            const response = await sendControlRequest(options.name, {
                op: "steer",
                body,
                force: Boolean(options.force),
            });
            if (!response.ok) {
                throw new Error(response.error);
            }

            out.result(SafeJSON.stringify(response.result ?? {}, null, 2));
        });
}
