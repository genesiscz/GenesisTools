import { out } from "@app/logger";
import { renderTree, type TreeNode } from "@app/utils/prompts/p/tree";
import { listTmuxSessions } from "@app/utils/tmux/sessions";
import { captureTmuxSnapshot, type TmuxSessionSnapshot } from "@app/utils/tmux/snapshot";
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
        .option("--detailed", "Include per-pane cwd / current command (default: true)", true)
        .option("--no-detailed", "Skip per-pane detail (faster)")
        .option("--prefix <str>", "Only sessions whose name starts with this prefix")
        .action((flags: ListFlags) => {
            runList(flags);
        });
}

export function runList(flags: ListFlags): void {
    if (flags.detailed) {
        const snapshot = captureTmuxSnapshot({ prefix: flags.prefix });

        const branches = resolveGitBranches(snapshot);

        if (flags.json) {
            const enriched = snapshot.map((s) => ({
                ...s,
                windows: s.windows.map((w) => ({
                    ...w,
                    panes: w.panes.map((p) => ({
                        ...p,
                        branch: (p.cwd && branches.get(p.cwd)) || undefined,
                    })),
                })),
            }));
            out.result(enriched);
            return;
        }

        if (snapshot.length === 0) {
            out.println(pc.dim("(no tmux sessions)"));
            return;
        }

        for (const session of snapshot) {
            const attach = session.attached ? pc.green("attached") : pc.dim("detached");
            out.println(`${pc.cyan(session.name)} ${pc.dim(`(${attach}, ${session.windows.length} window(s))`)}`);

            const windowNodes: TreeNode[] = session.windows.map((window) => {
                const wname = window.name ? ` ${pc.dim(window.name)}` : "";

                const paneNodes: TreeNode[] = window.panes.map((pane) => {
                    const cmd = pane.currentCommand ?? "?";
                    const details: TreeNode[] = [];

                    if (pane.cwd) {
                        const branch = branches.get(pane.cwd);
                        const branchStr = branch ? ` ${pc.magenta(branch)}` : "";
                        details.push({ text: `${pc.dim("cwd:")} ${pane.cwd}${branchStr}` });
                    }

                    if (pane.launchCommand) {
                        details.push({ text: `${pc.dim("cmd:")} ${pc.green(pane.launchCommand)}` });
                    }

                    if (pane.lastShellCommand) {
                        const lines = pane.lastShellCommand.split("\n");
                        details.push({ text: pc.dim(`› ${lines.join(" ")}`) });
                    }

                    return { text: `pane ${pane.index} ${pc.yellow(cmd)}`, children: details };
                });

                return { text: `window ${window.index}${wname}`, children: paneNodes };
            });

            for (const line of renderTree(windowNodes)) {
                out.println(line);
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

function resolveGitBranches(sessions: TmuxSessionSnapshot[]): Map<string, string> {
    const cwds = new Set<string>();
    for (const s of sessions) {
        for (const w of s.windows) {
            for (const p of w.panes) {
                if (p.cwd) {
                    cwds.add(p.cwd);
                }
            }
        }
    }

    const result = new Map<string, string>();
    for (const cwd of cwds) {
        try {
            const proc = Bun.spawnSync(["git", "rev-parse", "--abbrev-ref", "HEAD"], {
                cwd,
                stdio: ["ignore", "pipe", "pipe"],
            });

            const branch = proc.stdout.toString().trim();
            if (proc.exitCode === 0 && branch) {
                result.set(cwd, branch);
            }
        } catch {
            // not a git repo
        }
    }

    return result;
}
