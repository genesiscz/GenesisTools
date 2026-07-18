import { out } from "@app/logger";
import { SafeJSON } from "@app/utils/json";
import type { Command } from "commander";
import { sendControlRequest } from "../lib/control-channel";

export function registerRollbackCommand(program: Command): void {
    program
        .command("rollback")
        .description("Drop turns from the end of a Codex thread")
        .requiredOption("--name <name>", "Session name")
        .requiredOption("--turns <count>", "Number of turns to drop")
        .action(async (options: { name: string; turns: string }) => {
            const turns = Number.parseInt(options.turns, 10);
            if (!Number.isInteger(turns) || turns < 1) {
                throw new Error("--turns must be at least 1");
            }

            const response = await sendControlRequest(options.name, { op: "rollback", turns });
            if (!response.ok) {
                throw new Error(response.error);
            }

            out.result(SafeJSON.stringify(response.result ?? {}, null, 2));
        });
}
