import { DEFAULT_OLD_SUFFIX, forkSessionIntoCodeMode } from "@app/claude/lib/code-mode-fork";
import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import pc from "picocolors";

interface ForkFlags {
    title?: string;
    oldSuffix: string;
    dryRun?: boolean;
    json?: boolean;
}

/** Claude Code pins a session's mode at its start, so an ordinary session resumes without Code Mode even when it is on. */
export function registerForkWithCodeModeCommand(program: Command): void {
    program
        .command("fork-with-codemode <session>")
        .alias("fork-with-codemod")
        .description(
            "Copy a session that runs without Code Mode into a new session that resumes in Code Mode, and rename the old one"
        )
        .option("--title <title>", "Title of the new session (default: the old session's title)")
        .option("--old-suffix <suffix>", "Added to the old session's title", DEFAULT_OLD_SUFFIX)
        .option("--dry-run", "Print the plan and write nothing")
        .option("--json", "Print the outcome as JSON")
        .action(async (session: string, flags: ForkFlags) => {
            const outcome = await forkSessionIntoCodeMode({
                session,
                title: flags.title,
                oldSuffix: flags.oldSuffix,
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
                `${pc.bold("new")}  ${plan.forkId}  "${plan.title}"  (${planned ? "would write" : "wrote"} ${plan.forkPath})`
            );
            out.println(
                `${pc.bold("old")}  ${plan.sourceId}  ${planned ? "would be renamed" : "renamed"} to "${plan.oldTitle}"`
            );

            if (outcome.kind === "planned") {
                return;
            }

            const cd = outcome.fork.cwd ? `cd ${outcome.fork.cwd} && ` : "";
            out.println("");
            out.println(`Resume it with Code Mode on: ${pc.cyan(`${cd}claude --resume ${plan.forkId}`)}`);
        });
}
