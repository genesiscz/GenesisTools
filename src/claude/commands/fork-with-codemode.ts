import { resumeClaudeSession } from "@app/claude/commands/resume";
import { type CodeModeForkPlan, DEFAULT_BACKUP_SUFFIX, forkSessionIntoCodeMode } from "@app/claude/lib/code-mode-fork";
import { isInteractive } from "@genesiscz/utils/cli";
import { out } from "@genesiscz/utils/logger";
import * as p from "@genesiscz/utils/prompts/p";
import type { Command } from "commander";
import pc from "picocolors";

interface ForkFlags {
    title?: string;
    backupSuffix: string;
    dryRun?: boolean;
    json?: boolean;
}

type ResumeChoice = "codemode" | "backup" | "none";

/** In a terminal, offers to resume one of the two sessions; elsewhere, prints the command for the Code Mode one. */
async function offerResume(plan: CodeModeForkPlan, cwd: string | null): Promise<void> {
    const command = `${cwd ? `cd ${cwd} && ` : ""}claude --resume ${plan.sessionId}`;

    if (!isInteractive()) {
        out.println("");
        out.println(`Resume it with Code Mode on: ${pc.cyan(command)}`);
        return;
    }

    const choice = await p.select<ResumeChoice>({
        message: "Resume which session?",
        options: [
            { value: "codemode", label: `"${plan.title}" in Code Mode`, hint: plan.sessionId.slice(0, 8) },
            {
                value: "backup",
                label: `"${plan.backupTitle}" without Code Mode`,
                hint: `the copy, ${plan.backupId.slice(0, 8)}`,
            },
            { value: "none", label: "Neither", hint: "print the command" },
        ],
        cancel: "back",
    });

    if (p.isCancel(choice) || choice === "none") {
        out.println(`Resume it with Code Mode on: ${pc.cyan(command)}`);
        return;
    }

    await resumeClaudeSession({
        sessionId: choice === "codemode" ? plan.sessionId : plan.backupId,
        cwd: cwd ?? undefined,
    });
}

/** Claude Code pins a session's mode at its start, so an ordinary session resumes without Code Mode even when it is on. */
export function registerForkWithCodeModeCommand(program: Command): void {
    program
        .command("fork-with-codemode <session>")
        .alias("fork-with-codemod")
        .description(
            "Move a session into Code Mode: it keeps its id, and a copy under a new id keeps the conversation without Code Mode"
        )
        .option("--title <title>", "New title of the Code Mode session (default: its own title)")
        .option("--backup-suffix <suffix>", "Added to the title of the copy without Code Mode", DEFAULT_BACKUP_SUFFIX)
        .option("--dry-run", "Print the plan and write nothing")
        .option("--json", "Print the outcome as JSON")
        .action(async (session: string, flags: ForkFlags) => {
            const outcome = await forkSessionIntoCodeMode({
                session,
                title: flags.title,
                backupSuffix: flags.backupSuffix,
                dryRun: flags.dryRun,
            });

            if (outcome.kind === "refused") {
                process.exitCode = 1;
            }

            if (flags.json) {
                out.result(outcome);
                return;
            }

            if (outcome.kind === "refused") {
                out.log.error(outcome.reason);
                return;
            }

            const { plan } = outcome;
            const planned = outcome.kind === "planned";
            out.println(
                `${pc.bold("codemode")}  ${plan.sessionId}  "${plan.title}"  (${planned ? "would get" : "got"} the Code Mode marker)`
            );
            out.println(
                `${pc.bold("backup  ")}  ${plan.backupId}  "${plan.backupTitle}"  (${planned ? "would write" : "wrote"} ${plan.backupPath})`
            );

            if (outcome.kind === "forked") {
                await offerResume(plan, outcome.backup.cwd);
            }
        });
}
