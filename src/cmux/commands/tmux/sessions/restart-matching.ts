import { logger, out } from "@app/logger";
import { isInteractive, suggestCommand } from "@app/utils/cli";
import { withCancel } from "@app/utils/prompts/clack/helpers";
import { ensureTmuxServerPersists } from "@app/utils/tmux/sessions";
import {
    captureTmuxSnapshot,
    killTmuxSessionsMatching,
    restoreTmuxSession,
    SNAPSHOT_VERSION,
    type TmuxPreset,
} from "@app/utils/tmux/snapshot";
import { TmuxPresetStore } from "@app/utils/tmux/snapshot-store";
import * as p from "@clack/prompts";
import type { Command } from "commander";
import pc from "picocolors";

interface RestartFlags {
    yes?: boolean;
    skipReplay?: boolean;
    preset?: string;
    skipBackup?: boolean;
}

/**
 * `restart-matching <prefix>` = save → kill → restore for every tmux session
 * whose name starts with `<prefix>`. Designed for the dev-dashboard case where
 * we need to recycle ALL `dev-dashboard-*` sessions in one command (e.g. to
 * clear inherited environment poison after fixing the spawn env). Sessions
 * outside the prefix are left untouched, so an interactive cmux pane the user
 * is currently using is NOT killed.
 *
 * A snapshot is always written under cmux/tmux-presets/ first as a safety net
 * (unless --skip-backup) so the user can manually restore via
 * `tools cmux tmux sessions restore-preset <auto-name>` if anything goes wrong.
 */
export function registerRestartMatchingCommand(parent: Command): void {
    parent
        .command("restart-matching <prefix>")
        .description("Save → kill → restore every tmux session whose name starts with <prefix>")
        .option("-y, --yes", "Skip the confirmation prompt")
        .option("--skip-replay", "Don't pre-type the captured last shell command in each pane")
        .option("--preset <name>", "Save the snapshot under this preset name (default: auto-timestamped)")
        .option("--skip-backup", "Don't persist a preset file — riskier, but useful for tests")
        .action(async (prefix: string, flags: RestartFlags) => {
            await runRestartMatching(prefix, flags);
        });
}

export async function runRestartMatching(prefix: string, flags: RestartFlags): Promise<void> {
    if (!prefix || !prefix.trim()) {
        out.error("prefix is required (refuse to operate on all sessions)");
        process.exitCode = 1;
        return;
    }

    const sessions = captureTmuxSnapshot({ prefix });

    if (sessions.length === 0) {
        out.error(`No tmux sessions match prefix "${prefix}"`);
        process.exitCode = 1;
        return;
    }

    out.println(pc.bold(`Restart plan (prefix "${prefix}"):`));

    for (const session of sessions) {
        const attached = session.attached ? pc.yellow("(attached!)") : pc.dim("(detached)");
        out.println(`  ${pc.cyan(session.name)} ${attached}`);
    }

    const attachedCount = sessions.filter((s) => s.attached).length;

    if (attachedCount > 0) {
        out.println(
            pc.yellow(
                `\n⚠ ${attachedCount} session(s) are currently attached. Killing them will disconnect every active client.`
            )
        );
    }

    if (!flags.yes) {
        if (!isInteractive()) {
            out.error(
                `Pass --yes to skip the confirmation in non-interactive mode. ${suggestCommand(`tools cmux tmux sessions restart-matching ${prefix} --yes`)}`
            );
            process.exitCode = 1;
            return;
        }

        const proceed = await withCancel(
            p.confirm({
                message: `Kill and recreate ${sessions.length} session(s)?`,
                initialValue: false,
            })
        );

        if (!proceed) {
            p.cancel("Aborted.");
            return;
        }
    }

    const presetName = flags.preset?.trim() || defaultBackupName(prefix);
    const store = new TmuxPresetStore();

    const preset: TmuxPreset = {
        version: SNAPSHOT_VERSION,
        name: presetName,
        capturedAt: new Date().toISOString(),
        note: `restart-matching backup for prefix "${prefix}"`,
        sessions,
    };

    if (!flags.skipBackup) {
        try {
            const path = store.write(presetName, preset, { force: true });
            out.println(`${pc.dim("backup:")} ${path}`);
        } catch (error) {
            logger.error({ error, presetName }, "[tmux restart-matching] backup failed");
            out.error(
                `Backup write failed: ${error instanceof Error ? error.message : String(error)}. Aborting (run with --skip-backup to override).`
            );
            process.exitCode = 1;
            return;
        }
    }

    // Scrub the server's global env BEFORE killing — that way the new shells
    // spawned by the restore loop below don't re-inherit NO_COLOR / empty
    // COLORTERM that the founder process leaked into the server. Idempotent.
    ensureTmuxServerPersists();
    out.println(`${pc.dim("server env purged (NO_COLOR unset, COLORTERM=truecolor)")}`);

    const sessionNames = sessions.map((s) => s.name);
    const killed = killTmuxSessionsMatching(sessionNames);
    out.println(`${pc.dim("killed:")} ${killed.length}/${sessionNames.length}`);

    let created = 0;
    let skipped = 0;
    const failures: Array<{ name: string; error: unknown }> = [];

    for (const session of sessions) {
        try {
            const outcome = restoreTmuxSession(session, { skipReplay: flags.skipReplay });

            if (outcome.created) {
                created += 1;
                out.println(`  ${pc.green("✓")} ${pc.cyan(outcome.sessionName)}`);
            } else if (outcome.skipped) {
                skipped += 1;
                out.println(`  ${pc.dim("·")} ${pc.dim(`${outcome.sessionName} (${outcome.reason})`)}`);
            }
        } catch (error) {
            failures.push({ name: session.name, error });
            logger.error({ error, sessionName: session.name }, "[tmux restart-matching] restore failed");
            out.println(`  ${pc.red("✗")} ${session.name}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    out.println(
        `\nDone: ${pc.green(`${created} restored`)}, ${pc.dim(`${skipped} skipped`)}, ${failures.length ? pc.red(`${failures.length} failed`) : pc.dim("0 failed")}`
    );

    if (!flags.skipBackup) {
        out.println(pc.dim(`\nIf anything's wrong, restore the backup: tools cmux tmux sessions restore-preset ${presetName}`));
    }

    if (failures.length > 0) {
        process.exitCode = 1;
    }
}

function defaultBackupName(prefix: string): string {
    const now = new Date();
    const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}-${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}`;
    const sanitized = prefix.replace(/[^A-Za-z0-9._-]+/g, "_");
    return `restart-${sanitized}-${stamp}`;
}
