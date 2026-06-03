import { logger, out } from "@app/logger";
import { isInteractive, suggestCommand } from "@app/utils/cli";
import { withCancel } from "@app/utils/prompts/clack/helpers";
import { sessionExists } from "@app/utils/tmux/sessions";
import { restoreTmuxSession, type TmuxPreset } from "@app/utils/tmux/snapshot";
import { PresetNotFoundError, TmuxPresetStore } from "@app/utils/tmux/snapshot-store";
import * as p from "@clack/prompts";
import type { Command } from "commander";
import pc from "picocolors";

interface RestoreFlags {
    yes?: boolean;
    skipReplay?: boolean;
    suffix?: string;
    dryRun?: boolean;
    only?: string;
}

export function registerPresetRestoreCommand(parent: Command): void {
    parent
        .command("restore <name>")
        .description("Recreate tmux sessions from a saved preset (skips sessions that already exist)")
        .option("-y, --yes", "Skip the confirmation prompt")
        .option("--skip-replay", "Don't pre-type the captured last shell command in each pane")
        .option("--suffix <str>", "Append this suffix to every recreated session name (use when originals still alive)")
        .option("--dry-run", "Print the plan without touching tmux")
        .option("--only <prefix>", "Only restore sessions whose original name starts with this prefix")
        .action(async (name: string, flags: RestoreFlags) => {
            await runRestorePreset(name, flags);
        });
}

export async function runRestorePreset(name: string, flags: RestoreFlags): Promise<void> {
    const store = new TmuxPresetStore();

    let preset: TmuxPreset;
    try {
        preset = store.read(name);
    } catch (error) {
        if (error instanceof PresetNotFoundError) {
            out.error(error.message);
            process.exitCode = 1;
            return;
        }
        throw error;
    }

    const targets = preset.sessions.filter((s) => (flags.only ? s.name.startsWith(flags.only) : true));

    if (targets.length === 0) {
        out.error(
            flags.only
                ? `Preset "${name}" has no sessions matching --only "${flags.only}"`
                : `Preset "${name}" is empty`
        );
        process.exitCode = 1;
        return;
    }

    out.println(pc.bold(`Restore plan for preset ${pc.cyan(name)}:`));

    for (const session of targets) {
        const targetName = flags.suffix ? `${session.name}${flags.suffix}` : session.name;
        const clash = sessionExists(targetName);
        const note = clash ? pc.yellow("(skip — already exists)") : pc.dim(`(${countPanes(session)} pane(s))`);
        out.println(`  ${clash ? pc.dim(targetName) : pc.cyan(targetName)} ${note}`);
    }

    if (flags.dryRun) {
        out.println(pc.dim("\nDry run — nothing changed."));
        return;
    }

    if (!flags.yes) {
        if (!isInteractive()) {
            out.error(
                `Pass --yes to skip the confirmation in non-interactive mode. ${suggestCommand(`tools tmux presets restore ${name} --yes`)}`
            );
            process.exitCode = 1;
            return;
        }

        const proceed = await withCancel(
            p.confirm({ message: `Restore ${targets.length} session(s)?`, initialValue: true })
        );

        if (!proceed) {
            p.cancel("Aborted.");
            return;
        }
    }

    let created = 0;
    let skipped = 0;
    const failures: Array<{ name: string; error: unknown }> = [];

    for (const session of targets) {
        try {
            const outcome = restoreTmuxSession(session, {
                skipReplay: flags.skipReplay,
                nameSuffix: flags.suffix,
            });

            if (outcome.created) {
                created += 1;
                out.println(`  ${pc.green("✓")} ${pc.cyan(outcome.sessionName)}`);
            } else if (outcome.skipped) {
                skipped += 1;
                out.println(`  ${pc.dim("·")} ${pc.dim(`${outcome.sessionName} (${outcome.reason})`)}`);
            }
        } catch (error) {
            failures.push({ name: session.name, error });
            logger.error({ error, sessionName: session.name }, "[tmux presets restore] failed");
            out.println(`  ${pc.red("✗")} ${session.name}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    out.println(
        `\nDone: ${pc.green(`${created} created`)}, ${pc.dim(`${skipped} skipped`)}, ${failures.length ? pc.red(`${failures.length} failed`) : pc.dim("0 failed")}`
    );

    if (failures.length > 0) {
        process.exitCode = 1;
    }
}

function countPanes(session: { windows: { panes: unknown[] }[] }): number {
    let total = 0;
    for (const window of session.windows) {
        total += window.panes.length;
    }
    return total;
}
