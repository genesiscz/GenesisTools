import { getConfig } from "@app/dev-dashboard/config";
import { ttydLabel } from "@app/dev-dashboard/lib/ttyd/label";
import { isMeaningfulCommand } from "@app/dev-dashboard/lib/ttyd/naming";
import { logger, out } from "@genesiscz/utils/logger";
import { isProcessAlive } from "@genesiscz/utils/process-alive";
import { renderTree, type TreeNode } from "@genesiscz/utils/prompts/p/tree";
import { listTmuxSessions } from "@genesiscz/utils/tmux/sessions";
import { captureTmuxSnapshot, type TmuxPaneSnapshot, type TmuxSessionSnapshot } from "@genesiscz/utils/tmux/snapshot";
import type { Command } from "commander";
import pc from "picocolors";
import { formatTtydBranch, printSessionHeaderParts, type TtydSessionBinding } from "./sessions-format";

export type { TtydSessionBinding } from "./sessions-format";

interface ListFlags {
    json?: boolean;
    detailed?: boolean;
    prefix?: string;
}

/** Persisted ttyd registry bindings keyed by tmux session name (no process heal). */
export async function loadTtydBindingsByTmux(): Promise<Map<string, TtydSessionBinding[]>> {
    const map = new Map<string, TtydSessionBinding[]>();

    try {
        const config = await getConfig();

        for (const session of config.ttydSessions) {
            if (!session.tmuxSessionName) {
                continue;
            }

            // Skip stale registry rows whose ttyd process is gone (config lags until the
            // dashboard heals). In-process signal 0 — no fork/exec per registered session.
            if (typeof session.pid === "number" && session.pid > 0 && !isProcessAlive(session.pid)) {
                continue;
            }

            const binding: TtydSessionBinding = {
                id: session.id,
                port: session.port,
                label: ttydLabel(session),
                cwd: session.cwd,
            };
            const existing = map.get(session.tmuxSessionName) ?? [];
            existing.push(binding);
            map.set(session.tmuxSessionName, existing);
        }
    } catch (err) {
        // Dashboard config missing or unreadable — CLI still lists bare tmux sessions, but a
        // corrupt config silently dropping every ttyd binding must be diagnosable from the logs.
        logger.debug({ err }, "tmux sessions: could not read ttyd bindings from the dashboard config");
    }

    return map;
}

export function registerSessionsCommand(program: Command): void {
    program
        .command("sessions")
        .description("List live tmux sessions on the default socket")
        .option("--json", "Output as JSON")
        .option("--detailed", "Include per-pane cwd / current command (default: true)", true)
        .option("--no-detailed", "Skip per-pane detail (faster)")
        .option("--prefix <str>", "Only sessions whose name starts with this prefix")
        .action(async (flags: ListFlags) => {
            await runList(flags);
        });
}

export async function runList(flags: ListFlags): Promise<void> {
    const ttydByTmux = await loadTtydBindingsByTmux();

    if (flags.detailed) {
        const snapshot = await captureTmuxSnapshot({ prefix: flags.prefix });

        const branches = resolveGitBranches(snapshot);

        if (flags.json) {
            const enriched = snapshot.map((s) => ({
                ...s,
                ttyd: ttydByTmux.get(s.name) ?? [],
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
            printSessionHeader(session.name, session.attached, session.windows.length, ttydByTmux.get(session.name));

            const windowNodes: TreeNode[] = [];
            const ttydTabs = ttydByTmux.get(session.name);

            if (ttydTabs && ttydTabs.length > 0) {
                windowNodes.push({
                    text: formatTtydBranch(ttydTabs, {
                        head: pc.cyan,
                        label: pc.white,
                        command: pc.yellow,
                        separator: pc.dim,
                    }),
                });
            }

            for (const window of session.windows) {
                const wname = window.name ? ` ${pc.dim(window.name)}` : "";

                const paneNodes: TreeNode[] = window.panes.map((pane) => {
                    const cmd = pane.currentCommand ?? "?";

                    return {
                        text: `pane ${pane.index} ${pc.yellow(cmd)}`,
                        children: buildPaneDetailNodes(pane, branches),
                    };
                });

                windowNodes.push({ text: `window ${window.index}${wname}`, children: paneNodes });
            }

            for (const line of renderTree(windowNodes)) {
                out.println(line);
            }
        }

        return;
    }

    const sessions = (await listTmuxSessions()).filter((s) => (flags.prefix ? s.name.startsWith(flags.prefix) : true));

    if (flags.json) {
        out.result(
            sessions.map((s) => ({
                ...s,
                ttyd: ttydByTmux.get(s.name) ?? [],
            }))
        );
        return;
    }

    if (sessions.length === 0) {
        out.println(pc.dim("(no tmux sessions)"));
        return;
    }

    for (const session of sessions) {
        printSessionHeader(session.name, session.attached > 0, session.windows, ttydByTmux.get(session.name));
    }
}

function printSessionHeader(
    name: string,
    attached: boolean,
    windowCount: number,
    ttydTabs: TtydSessionBinding[] | undefined
): void {
    const attach = attached ? pc.green("attached") : pc.dim("detached");
    const { windows, ttyd } = printSessionHeaderParts(name, attached, windowCount, ttydTabs);
    out.println(
        `${pc.cyan(name)} ${pc.dim("(")}${attach}${pc.dim(`, ${windows}`)}${ttyd ? pc.cyan(ttyd) : ""}${pc.dim(")")}`
    );
}

function buildPaneDetailNodes(
    pane: TmuxPaneSnapshot | undefined,
    branches: Map<string, string>
): TreeNode[] | undefined {
    if (!pane) {
        return undefined;
    }

    const details: TreeNode[] = [];

    if (pane.cwd) {
        const branch = branches.get(pane.cwd);
        const branchStr = branch ? ` ${pc.magenta(branch)}` : "";
        details.push({ text: `${pc.dim("cwd:")} ${pane.cwd}${branchStr}` });
    }

    if (pane.launchCommand && isMeaningfulCommand(commandBasename(pane.launchCommand))) {
        details.push({ text: `${pc.dim("cmd:")} ${pc.green(pane.launchCommand)}` });
    } else if (isMeaningfulCommand(pane.currentCommand)) {
        details.push({ text: `${pc.dim("cmd:")} ${pc.yellow(pane.currentCommand)}` });
    }

    if (pane.lastShellCommand) {
        const line = pane.lastShellCommand.split("\n").join(" ").trim();
        const foreground = (pane.currentCommand ?? "").trim().toLowerCase();
        const launch = pane.launchCommand ?? "";
        const tuiForeground = new Set(["claude", "claude-code", "vim", "nvim", "less", "htop", "nano"]);
        const agentLaunch = /\b(claude|claude-code|tools\s+cc)\b/i.test(launch);

        // TUIs / agent launchers own the screen — scrollback "prompt" hits are chrome.
        if (line.length > 0 && !tuiForeground.has(foreground) && !agentLaunch) {
            details.push({ text: `${pc.dim("last:")} ${line}` });
        }
    }

    return details.length > 0 ? details : undefined;
}

function commandBasename(command: string): string {
    const first = command.trim().split(/\s+/)[0] ?? "";
    return first.split("/").pop() ?? first;
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
