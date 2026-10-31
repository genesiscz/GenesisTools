import { parseNonNegativeInt } from "@genesiscz/utils/cli/parse";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import { APPROVAL_ACTORS, parseApprovalRefusal } from "../lib/control";
import { sendControlRequest } from "../lib/control-channel";
import {
    LIST_PREVIEW_LINES,
    listPendingRequests,
    type PendingRequest,
    renderPendingApproval,
} from "../lib/pending-approval";
import { CodexSessionStore } from "../lib/store";

interface DenyOptions {
    name: string;
    request: string;
    reason?: string;
    by?: string;
}

async function answerApproval(options: DenyOptions, decision: "approve" | "deny"): Promise<void> {
    const refusal =
        decision === "deny" && (options.reason !== undefined || options.by !== undefined)
            ? parseApprovalRefusal({ by: options.by ?? "parent", reason: options.reason })
            : undefined;
    const response = await sendControlRequest(
        options.name,
        decision === "approve"
            ? { op: "approve", requestId: options.request }
            : { op: "deny", requestId: options.request, ...(refusal ? { refusal } : {}) }
    );
    if (!response.ok) {
        throw new Error(response.error);
    }

    out.result(SafeJSON.stringify(response.result ?? {}, null, 2));
}

/** `--json` answers with the stored record itself: the exact proposed content, never a cut preview. */
function jsonRecord(request: PendingRequest): Record<string, unknown> {
    return { session: request.session, requestId: request.requestId, ...request.approval };
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
        .option(
            "--reason <text>",
            "Why it is declined; steered to the worker with the actor, so a lead's quality refusal never reads as a human permission decision"
        )
        .option("--by <actor>", `Who declines: ${APPROVAL_ACTORS.join(", ")} (default parent when --reason is given)`)
        .action(async (options: DenyOptions) => {
            await answerApproval(options, "deny");
        });

    program
        .command("requests")
        .description(
            "List pending approval requests: each command, and each file change's path with its proposed content or diff, cut to --lines per request"
        )
        .option("--name <name>", "Session name; omit to list the requests of every session")
        .option(
            "--lines <count>",
            "Content lines shown per request before the truncation marker",
            String(LIST_PREVIEW_LINES)
        )
        .option("--json", "Emit the stored records with their full content as JSON")
        .action((options: { name?: string; lines: string; json?: boolean }) => {
            const maxLines = parseNonNegativeInt(options.lines, "--lines");
            const requests = listPendingRequests(new CodexSessionStore(), options.name);

            if (options.json) {
                out.result(requests.map(jsonRecord));
                return;
            }

            if (requests.length === 0) {
                out.printlnErr(options.name ? `No pending requests for ${options.name}.` : "No pending requests.");
                return;
            }

            const blocks = requests.map((request) =>
                renderPendingApproval({
                    name: request.session,
                    requestId: request.requestId,
                    approval: request.approval,
                    maxLines,
                }).join("\n")
            );
            out.println(blocks.join("\n\n"));
        });

    program
        .command("request")
        .description("Show one pending approval request; --full prints every proposed line")
        .requiredOption("--name <name>", "Session name")
        .requiredOption("--request <id>", "Approval request id")
        .option("--full", "Print the whole proposed content or diff instead of the first lines")
        .option("--json", "Emit the stored record with its full content as JSON")
        .action((options: { name: string; request: string; full?: boolean; json?: boolean }) => {
            const request = listPendingRequests(new CodexSessionStore(), options.name).find(
                (candidate) => candidate.requestId === options.request
            );

            if (!request) {
                throw new Error(
                    `No pending request ${options.request} for ${options.name}: it was answered, or the id is wrong. List them with ${toolCommand("codex requests", "--name", options.name)}`
                );
            }

            if (options.json) {
                out.result(jsonRecord(request));
                return;
            }

            out.println(
                renderPendingApproval({
                    name: request.session,
                    requestId: request.requestId,
                    approval: request.approval,
                    ...(options.full ? {} : { maxLines: LIST_PREVIEW_LINES }),
                }).join("\n")
            );
        });
}
