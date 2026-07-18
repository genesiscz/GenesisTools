import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import { sendControlRequest } from "../lib/control-channel";

export function registerReadCommand(program: Command): void {
    program
        .command("read")
        .description("Read the current Codex thread snapshot")
        .requiredOption("--name <name>", "Session name")
        .action(async (options: { name: string }) => {
            const response = await sendControlRequest(options.name, { op: "read" });
            if (!response.ok) {
                throw new Error(response.error);
            }

            out.result(SafeJSON.stringify(response.result ?? null, null, 2));
        });
}
