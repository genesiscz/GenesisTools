import { Command } from "commander";
import * as p from "@clack/prompts";
import pc from "picocolors";
import logger from "@app/logger";
import { buildPlan, restoreProfile, type RestoreOptions } from "@app/cmux/lib/restore";
import { ProfileNotFoundError, ProfileStore } from "@app/cmux/lib/store";
import { isInteractive } from "@app/utils/cli";
import { withCancel } from "@app/utils/prompts/clack/helpers";

interface RestoreFlags {
    prefix?: string;
    replay?: boolean;
    yes?: boolean;
    dryRun?: boolean;
}

export function registerRestoreCommand(parent: Command): void {
    parent
        .command("restore <name>")
        .description("Recreate cmux workspaces from a saved profile (always non-destructive)")
        .option("--prefix <str>", "Workspace name prefix to apply on restore (default '<name>-')")
        .option("--no-replay", "Skip queueing the captured shell command — only cd into cwd")
        .option("-y, --yes", "Do not ask for confirmation")
        .option("--dry-run", "Print the plan without modifying cmux")
        .action(async (name: string, flags: RestoreFlags) => {
            await runRestore(name, flags);
        });
}

async function runRestore(name: string, flags: RestoreFlags): Promise<void> {
    const store = new ProfileStore();
    let profile;
    try {
        profile = store.read(name);
    } catch (error) {
        if (error instanceof ProfileNotFoundError) {
            console.error(error.message);
            process.exitCode = 1;
            return;
        }
        throw error;
    }

    const opts: RestoreOptions = {
        prefix: flags.prefix !== undefined ? flags.prefix : `${name}-`,
        replay: flags.replay !== false,
        yes: !!flags.yes,
        dryRun: !!flags.dryRun,
    };

    const plan = buildPlan(profile, opts);

    p.intro(pc.bgCyan(pc.black(" cmux profiles restore ")));
    const planLines = plan.workspaces.map((ws) => {
        return `  ${pc.cyan(ws.targetTitle)} ${pc.dim(`(${ws.paneCount} pane(s), ${ws.surfaceCount} surface(s))`)}`;
    });
    p.note(planLines.join("\n") || "(empty profile)", `Restore plan for ${pc.cyan(name)}`);

    if (opts.dryRun) {
        p.outro(pc.dim("Dry run — nothing changed."));
        return;
    }

    if (!opts.yes) {
        if (!isInteractive()) {
            console.error("Pass --yes to skip the confirmation in non-interactive mode.");
            process.exitCode = 1;
            return;
        }
        const proceed = await withCancel(
            p.confirm({ message: `Create ${plan.workspaces.length} workspace(s)?`, initialValue: true }),
        );
        if (!proceed) {
            p.cancel("Aborted.");
            return;
        }
    }

    const spinner = p.spinner();
    spinner.start("Recreating workspaces…");
    const startedAt = Date.now();

    try {
        const outcome = await restoreProfile(profile, opts, {
            onWorkspaceStart: ({ title, index, total }) => {
                spinner.message(`Restoring ${index}/${total}: ${title}`);
            },
        });
        spinner.stop(`Restored ${outcome.workspaces.length} workspace(s) in ${Date.now() - startedAt} ms`);

        const summary = outcome.workspaces
            .map((w) => {
                const status = w.converged ? pc.green("✓") : pc.yellow("≈");
                return `  ${status} ${pc.cyan(w.title)} ${pc.dim(`(${w.iterations} resize iter${w.iterations === 1 ? "" : "s"})`)}`;
            })
            .join("\n");
        p.note(summary, "Result");
        p.outro(pc.green("Done."));
    } catch (error) {
        spinner.stop("Restore failed.");
        logger.error({ error }, "[cmux restore] failed");
        throw error;
    }
}
