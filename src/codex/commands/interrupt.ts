import { out } from "@app/logger";
import { SafeJSON } from "@app/utils/json";
import type { Command } from "commander";
import { sendControlRequest } from "../lib/control-channel";

export function registerInterruptCommand(program: Command): void {
    program
        .command("interrupt")
        .description("Interrupt the active Codex turn")
        .requiredOption("--name <name>", "Session name")
        .action(async (options: { name: string }) => {
            const response = await sendControlRequest(options.name, { op: "interrupt" });
            if (!response.ok) {
                throw new Error(response.error);
            }

            out.result(SafeJSON.stringify(response.result ?? {}, null, 2));
        });
}
