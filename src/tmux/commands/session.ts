import { out } from "@app/logger";
import { runList } from "@app/tmux/commands/sessions";
import { isInteractive, suggestCommand } from "@app/utils/cli";
import * as p from "@app/utils/prompts/p";
import { resolveSessionQuery } from "@app/utils/tmux/match";
import { resetSessions, selectResetTargets } from "@app/utils/tmux/reset";
import { attachTmuxSession, listTmuxSessions } from "@app/utils/tmux/sessions";
import type { TmuxSessionInfo } from "@app/utils/tmux/types";
import type { Command } from "commander";
import pc from "picocolors";

interface ResetCliFlags {
    yes?: boolean;
    skipReplay?: boolean;
    preset?: string;
    skipBackup?: boolean;
    matching?: string;
}

export function registerSessionCommand(program: Command): void {
    const session = program
        .command("session")
        .description("Operate on individual tmux sessions (reset / attach)")
        .action((_opts: unknown, cmd: Command) => {
            runList({ detailed: true });
            out.println("");
            cmd.outputHelp();
        });

    session
        .command("reset [sessionId]")
        .description("Save → kill → restore a single session (or all with --matching)")
        .option("--matching <pattern>", "Reset every session whose name starts with <pattern> (instead of one id)")
        .option("-y, --yes", "Skip the confirmation prompt")
        .option("--skip-replay", "Don't pre-type the captured last shell command in each pane")
        .option("--preset <name>", "Save the backup snapshot under this name (default: auto-timestamped)")
        .option("--skip-backup", "Don't persist a backup preset — riskier, but useful for tests")
        .action(async (sessionId: string | undefined, flags: ResetCliFlags) => {
            await runReset(sessionId, flags);
        });

    session
        .command("attach <query>")
        .description("Attach to a session by exact name, or pick from substring matches")
        .action(async (query: string) => {
            await runAttach(query);
        });
}

export async function runReset(sessionId: string | undefined, flags: ResetCliFlags): Promise<void> {
    const selection = selectResetTargets({ sessionId, matching: flags.matching });

    if (!selection.ok) {
        out.error(selection.error);
        process.exitCode = 1;
        return;
    }

    const { targets } = selection;

    out.println(pc.bold(`Reset plan (${targets.label}):`));

    for (const session of targets.sessions) {
        const attached = session.attached ? pc.yellow("(attached!)") : pc.dim("(detached)");
        out.println(`  ${pc.cyan(session.name)} ${attached}`);
    }

    const attachedCount = targets.sessions.filter((s) => s.attached).length;

    if (attachedCount > 0) {
        out.println(
            pc.yellow(
                `\n⚠ ${attachedCount} session(s) are currently attached. Killing them will disconnect every active client.`
            )
        );
    }

    if (!flags.yes) {
        if (!isInteractive()) {
            const cmd = targets.single
                ? `tools tmux session reset ${sessionId} --yes`
                : `tools tmux session reset --matching ${flags.matching} --yes`;
            out.error(`Pass --yes to skip the confirmation in non-interactive mode. ${suggestCommand(cmd)}`);
            process.exitCode = 1;
            return;
        }

        const proceed = await p.confirm({
            message: `Kill and recreate ${targets.sessions.length} session(s)?`,
            initialValue: false,
        });

        if (!proceed) {
            out.println(pc.dim("Aborted."));
            return;
        }
    }

    const result = resetSessions({
        targets,
        options: { skipReplay: flags.skipReplay, preset: flags.preset, skipBackup: flags.skipBackup },
    });

    if (result.aborted) {
        out.error(`Backup write failed: ${result.backupError}. Aborting (run with --skip-backup to override).`);
        process.exitCode = 1;
        return;
    }

    if (result.presetPath) {
        out.println(`${pc.dim("backup:")} ${result.presetPath}`);
    }

    out.println(`${pc.dim("server env purged (NO_COLOR unset, COLORTERM=truecolor)")}`);
    out.println(`${pc.dim("killed:")} ${result.killed.length}/${targets.sessions.length}`);

    let created = 0;
    let skipped = 0;

    for (const outcome of result.outcomes) {
        if (outcome.created) {
            created += 1;
            out.println(`  ${pc.green("✓")} ${pc.cyan(outcome.sessionName)}`);
        } else if (outcome.skipped) {
            skipped += 1;
            out.println(`  ${pc.dim("·")} ${pc.dim(`${outcome.sessionName} (${outcome.reason})`)}`);
        }
    }

    for (const failure of result.failures) {
        out.println(
            `  ${pc.red("✗")} ${failure.name}: ${failure.error instanceof Error ? failure.error.message : String(failure.error)}`
        );
    }

    out.println(
        `\nDone: ${pc.green(`${created} restored`)}, ${pc.dim(`${skipped} skipped`)}, ${result.failures.length ? pc.red(`${result.failures.length} failed`) : pc.dim("0 failed")}`
    );

    if (!flags.skipBackup) {
        out.println(
            pc.dim(`\nIf anything's wrong, restore the backup: tools tmux presets restore ${result.presetName}`)
        );
    }

    if (result.failures.length > 0) {
        process.exitCode = 1;
    }
}

export async function runAttach(query: string): Promise<void> {
    const sessions = listTmuxSessions();
    const match = resolveSessionQuery(query, sessions);
    const isTty = Boolean(process.stdin.isTTY);

    if (match.kind === "none") {
        out.error(`No tmux session matching "${query}".`);
        out.println(pc.bold("Available sessions:"));
        printSessions(sessions);
        process.exitCode = 1;
        return;
    }

    if (match.kind === "ambiguous") {
        if (!isTty) {
            out.error(
                `"${query}" matches ${match.matches.length} sessions; be more specific (no TTY to pick interactively).`
            );
            out.println(pc.bold("Matches:"));
            printSessions(sessions.filter((s) => match.matches.includes(s.name)));
            out.println(pc.bold("All sessions:"));
            printSessions(sessions);
            process.exitCode = 1;
            return;
        }

        const chosen = await p.select({
            message: `${match.matches.length} sessions match "${query}" — pick one to attach:`,
            options: sessions
                .filter((s) => match.matches.includes(s.name))
                .map((s) => ({
                    value: s.name,
                    label: s.name,
                    hint: s.attached > 0 ? "attached" : "detached",
                })),
        });

        attachOrExplain(String(chosen), sessions, isTty);
        return;
    }

    attachOrExplain(match.name, sessions, isTty);
}

function attachOrExplain(name: string, sessions: TmuxSessionInfo[], isTty: boolean): void {
    if (!isTty) {
        out.error(`Attaching needs a TTY (stdin is not a terminal). Resolved session: ${name}`);
        out.println(pc.dim(`Attach manually with: tmux attach-session -t ${name}`));
        out.println(pc.bold("All sessions:"));
        printSessions(sessions);
        process.exitCode = 1;
        return;
    }

    attachTmuxSession(name);
}

function printSessions(sessions: TmuxSessionInfo[]): void {
    if (sessions.length === 0) {
        out.println(pc.dim("(no tmux sessions)"));
        return;
    }

    for (const session of sessions) {
        const state = session.attached > 0 ? pc.green("attached") : pc.dim("detached");
        out.println(
            `  ${pc.cyan(session.name)} ${pc.dim(`(${state}, ${session.windows} window${session.windows === 1 ? "" : "s"})`)}`
        );
    }
}
