import { out } from "@app/logger";
import { SafeJSON } from "@app/utils/json";
import type { Command } from "commander";
import { sendControlRequest } from "../lib/control-channel";

export function registerStopCommand(program: Command): void {
    program
        .command("stop")
        .description("Stop a Codex session")
        .requiredOption("--name <name>", "Session name")
        .action(async (options: { name: string }) => {
            const response = await sendControlRequest(options.name, { op: "stop" });
            if (!response.ok) {
                throw new Error(response.error);
            }

            out.result(SafeJSON.stringify(response.result ?? { stopped: true }, null, 2));
        });
}
