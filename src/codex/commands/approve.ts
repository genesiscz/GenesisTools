import { SafeJSON } from "@app/utils/json";
import { out } from "@app/utils/logger";
import type { Command } from "commander";
import { sendControlRequest } from "../lib/control-channel";

async function answerApproval(options: { name: string; request: string }, decision: "approve" | "deny"): Promise<void> {
    const response = await sendControlRequest(options.name, {
        op: decision,
        requestId: options.request,
    });
    if (!response.ok) {
        throw new Error(response.error);
    }

    out.result(SafeJSON.stringify(response.result ?? {}, null, 2));
}

export function registerApprovalCommands(program: Command): void {
    program
        .command("approve")
        .description("Approve a pending Codex request")
        .requiredOption("--name <name>", "Session name")
        .requiredOption("--request <id>", "Approval request id")
        .action(async (options: { name: string; request: string }) => {
            await answerApproval(options, "approve");
        });

    program
        .command("deny")
        .description("Deny a pending Codex request")
        .requiredOption("--name <name>", "Session name")
        .requiredOption("--request <id>", "Approval request id")
        .action(async (options: { name: string; request: string }) => {
            await answerApproval(options, "deny");
        });
}
