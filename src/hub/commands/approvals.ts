import { APPROVAL_VERDICTS, type ApprovalVerdict } from "@genesiscz/utils/agents/approvals/keys";
import { suggestEnumFlag } from "@genesiscz/utils/cli";
import { out } from "@genesiscz/utils/logger";
import { createBoxTable, renderCliHeader, truncateDisplay } from "@genesiscz/utils/table";
import type { Command } from "commander";
import { answerPendingApproval, listPendingApprovals, type PendingApproval } from "../lib/approvals/index";

function detailLine(approval: PendingApproval): string {
    const { detail } = approval;

    if (detail.kind === "command") {
        return detail.cwd ? `${detail.command}  (in ${detail.cwd})` : detail.command;
    }

    if (detail.kind === "file-change") {
        return detail.changes.map((change) => change.path).join(", ");
    }

    return detail.kind === "plan" ? detail.plan.split("\n")[0] : detail.input;
}

function isVerdict(value: string | undefined): value is ApprovalVerdict {
    return APPROVAL_VERDICTS.some((verdict) => verdict === value);
}

/**
 * `tools hub approvals`: every tool call that waits for allow or deny (pane permission and plan dialogs, `tools codex`
 * worker requests), as the phone's Approvals screen shows it (`/api/gateway/approvals`), and `tools hub approvals
 * answer <id> --verdict <v>`, its buttons (`POST /api/approvals/answer`).
 */
export function registerApprovalsCommand(program: Command): void {
    const approvals = program
        .command("approvals")
        .description("Tool calls that wait for allow or deny: permission and plan dialogs, codex worker requests")
        .option("--json", "machine-readable output")
        .action(async (_opts: unknown, command: Command) => {
            const opts = command.optsWithGlobals<{ json?: boolean }>();
            const pending = await listPendingApprovals();

            if (opts.json) {
                out.result({ pending });
                return;
            }

            renderCliHeader("Waiting for allow or deny", `${pending.length} waiting`);
            const table = createBoxTable(["ID", "AGENT", "DIALOG", "TOOL", "WHAT"]);

            for (const approval of pending) {
                table.push([
                    approval.id,
                    `${approval.provider} ${approval.backend}`,
                    approval.dialog,
                    approval.tool,
                    truncateDisplay(detailLine(approval), 60),
                ]);
            }

            out.println(table.toString());
        });

    approvals
        .command("answer <id>")
        .description(
            "Allow or deny one waiting tool call (pane keys through cmux, or the codex worker's control channel)"
        )
        .option("--verdict [verdict]", `${APPROVAL_VERDICTS.join(" | ")}`)
        .option("--reason <text>", "words for the agent with a deny")
        .option("--json", "machine-readable output")
        .action(async (id: string, _opts: unknown, command: Command) => {
            const opts = command.optsWithGlobals<{ verdict?: string; reason?: string; json?: boolean }>();

            if (!isVerdict(opts.verdict)) {
                out.log.error(suggestEnumFlag("tools hub approvals answer <id>", "--verdict", APPROVAL_VERDICTS));
                process.exitCode = 1;
                return;
            }

            const receipt = await answerPendingApproval({ id, verdict: opts.verdict, reason: opts.reason });
            process.exitCode = receipt.outcome === "sent" ? 0 : 1;

            if (opts.json) {
                out.result(receipt);
                return;
            }

            const line = `${receipt.outcome} via ${receipt.route}: ${receipt.detail}`;

            if (receipt.outcome === "sent") {
                out.log.success(line);
                return;
            }

            out.log.error(line);
        });
}
