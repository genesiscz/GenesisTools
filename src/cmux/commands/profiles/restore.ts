import { renderProfileCommandDetail } from "@app/cmux/lib/format";
import { buildPlan, type RestoreOptions, reportWaitingPrompts, restoreProfile } from "@app/cmux/lib/restore";
import { ProfileNotFoundError, ProfileStore } from "@app/cmux/lib/store";
import type { Profile } from "@app/cmux/lib/types";
import * as p from "@clack/prompts";
import { isInteractive, suggestCommand } from "@genesiscz/utils/cli";
import { ensureCmuxResponsive } from "@genesiscz/utils/cmux/lib/health";
import { logger, out } from "@genesiscz/utils/logger";
import { withCancel } from "@genesiscz/utils/prompts/clack/helpers";
import type { Command } from "commander";
import pc from "picocolors";

interface RestoreFlags {
    prefix?: string;
    replay?: boolean;
    enter?: boolean;
    yes?: boolean;
    dryRun?: boolean;
}

export function registerRestoreCommand(parent: Command): void {
    parent
        .command("restore <name>")
        .description("Recreate cmux workspaces from a saved profile (always non-destructive)")
        .option("--prefix <str>", "Workspace name prefix to apply on restore (default '<name>-')")
        .option("--no-replay", "Skip queueing the captured shell command — only cd into cwd")
        .option("--enter", "Press Enter after typing each replayed command, so it executes immediately")
        .option("-y, --yes", "Do not ask for confirmation")
        .option("--dry-run", "Print the plan without modifying cmux")
        .action(async (name: string, flags: RestoreFlags) => {
            await runRestore(name, flags);
        });
}

async function runRestore(name: string, flags: RestoreFlags): Promise<void> {
    const store = new ProfileStore();
    let profile: Profile;
    try {
        profile = store.read(name);
    } catch (error) {
        if (error instanceof ProfileNotFoundError) {
            out.error(error.message);
            process.exitCode = 1;
            return;
        }
        throw error;
    }

    const opts: RestoreOptions = {
        prefix: flags.prefix !== undefined ? flags.prefix : `${name}-`,
        replay: flags.replay !== false,
        enter: !!flags.enter && flags.replay !== false,
        yes: !!flags.yes,
        dryRun: !!flags.dryRun,
    };

    if (flags.enter && flags.replay === false) {
        out.log.warn("--enter has no effect with --no-replay; commands are not typed at all.");
    }

    const plan = buildPlan(profile, opts);

    p.intro(pc.bgCyan(pc.black(" cmux profiles restore ")));
    const planLines = plan.workspaces.map((ws) => {
        return `  ${pc.cyan(ws.targetTitle)} ${pc.dim(`(${ws.paneCount} pane(s), ${ws.surfaceCount} surface(s))`)}`;
    });
    p.note(planLines.join("\n") || "(empty profile)", `Restore plan for ${pc.cyan(name)}`);

    const detail = renderProfileCommandDetail(profile);
    if (detail.length > 0) {
        p.note(detail.join("\n"), "Panes · commands · drift");
    }

    if (opts.dryRun) {
        p.outro(pc.dim("Dry run — nothing changed."));
        return;
    }

    if (!opts.yes) {
        if (!isInteractive()) {
            out.error(
                `Pass --yes to skip the confirmation in non-interactive mode. ${suggestCommand(`tools cmux profiles restore ${name} --yes`)}`
            );
            process.exitCode = 1;
            return;
        }
        const proceed = await withCancel(
            p.confirm({ message: `Create ${plan.workspaces.length} workspace(s)?`, initialValue: true })
        );
        if (!proceed) {
            p.cancel("Aborted.");
            return;
        }
    }

    await ensureCmuxResponsive("profiles restore");

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
                const dimensionNote = w.converged
                    ? "exact size match"
                    : `off by ${w.maxCellDelta} cell${w.maxCellDelta === 1 ? "" : "s"}`;
                return `  ${status} ${pc.cyan(w.title)} ${pc.dim(`(${dimensionNote})`)}`;
            })
            .join("\n");
        p.note(summary, "Result");

        if (opts.enter) {
            await reportWaitingPrompts(
                outcome.workspaces.map((w) => w.ref),
                "Restore"
            );
        }

        p.outro(pc.green("Done."));
    } catch (error) {
        spinner.stop("Restore failed.");
        logger.error({ error }, "[cmux restore] failed");
        throw error;
    }
}
