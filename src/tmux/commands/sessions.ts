import { out } from "@app/logger";
import { listTmuxSessions } from "@app/utils/tmux/sessions";
import { captureTmuxSnapshot } from "@app/utils/tmux/snapshot";
import type { Command } from "commander";
import pc from "picocolors";

interface ListFlags {
    json?: boolean;
    detailed?: boolean;
    prefix?: string;
}

export function registerSessionsCommand(program: Command): void {
    program
        .command("sessions")
        .description("List live tmux sessions on the default socket")
        .option("--json", "Output as JSON")
        .option("--detailed", "Include per-pane cwd / current command (slower; runs capture)")
        .option("--prefix <str>", "Only sessions whose name starts with this prefix")
        .action((flags: ListFlags) => {
            runList(flags);
        });
}

export function runList(flags: ListFlags): void {
    if (flags.detailed) {
        const snapshot = captureTmuxSnapshot({ prefix: flags.prefix, skipHistory: true });

        if (flags.json) {
            out.result(snapshot);
            return;
        }

        if (snapshot.length === 0) {
            out.println(pc.dim("(no tmux sessions)"));
            return;
        }

        for (const session of snapshot) {
            const attach = session.attached ? pc.green("attached") : pc.dim("detached");
            out.println(`${pc.cyan(session.name)} ${pc.dim(`(${attach}, ${session.windows.length} window(s))`)}`);

            for (const window of session.windows) {
                const wname = window.name ? ` ${pc.dim(window.name)}` : "";
                out.println(`  window ${window.index}${wname}`);

                for (const pane of window.panes) {
                    const cmd = pane.currentCommand ?? pc.dim("?");
                    const cwd = pane.cwd ?? pc.dim("?");
                    out.println(`    pane ${pane.index} ${pc.yellow(cmd)} ${pc.dim(cwd)}`);
                }
            }
        }

        return;
    }

    const sessions = listTmuxSessions().filter((s) => (flags.prefix ? s.name.startsWith(flags.prefix) : true));

    if (flags.json) {
        out.result(sessions);
        return;
    }

    if (sessions.length === 0) {
        out.println(pc.dim("(no tmux sessions)"));
        return;
    }

    for (const session of sessions) {
        const attach = session.attached > 0 ? pc.green("attached") : pc.dim("detached");
        out.println(
            `${pc.cyan(session.name)} ${pc.dim(`(${attach}, ${session.windows} window${session.windows === 1 ? "" : "s"})`)}`
        );
    }
}
