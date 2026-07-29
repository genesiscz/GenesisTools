import { logger } from "@genesiscz/utils/logger";
import { profiler } from "@genesiscz/utils/profile";
import { resolveTmuxBin } from "@genesiscz/utils/tmux/bin";
import type { LiveTeammateProcess, TeamMemberView } from "./types";

const prof = profiler.scope("teams");

interface PsRow {
    pid: number;
    ppid: number;
    command: string;
}

export interface PsResult {
    exitCode: number;
    stdout: string;
    stderr: string;
}

export type PsRunner = (cmd: string[]) => PsResult;

const defaultPsRunner: PsRunner = (cmd) => {
    const proc = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });

    return {
        exitCode: proc.exitCode ?? -1,
        stdout: proc.stdout.toString(),
        stderr: proc.stderr.toString(),
    };
};

let psRunner: PsRunner = defaultPsRunner;

/** Test seam for the `ps` calls, mirroring __setPersistRegistryForTest in ttyd/manager. */
export function __setPsRunnerForTest(runner: PsRunner | null): void {
    psRunner = runner ?? defaultPsRunner;
}

/**
 * null means the SCAN ITSELF failed, which is not the same fact as "nothing is
 * running" — callers must not render a teammate as stopped on the strength of a
 * process table we never actually read.
 */
function listAllProcesses(): PsRow[] | null {
    try {
        const result = psRunner(["ps", "-ax", "-o", "pid=,ppid=,command="]);

        // A nonzero exit is not an exception, so this cannot be left to the catch.
        if (result.exitCode !== 0) {
            logger.warn(
                { exitCode: result.exitCode, stderr: result.stderr.trim() },
                "[teams] ps -ax failed; live status is unknown for every teammate"
            );
            return null;
        }

        const rows: PsRow[] = [];
        for (const line of result.stdout.split("\n")) {
            const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
            if (!m) {
                continue;
            }

            rows.push({ pid: Number(m[1]), ppid: Number(m[2]), command: m[3] });
        }

        return rows;
    } catch (error) {
        logger.warn({ error }, "[teams] ps -ax could not be spawned; live status is unknown");
        return null;
    }
}

function listClaudeLikeProcesses(all: PsRow[]): PsRow[] {
    return all.filter((row) => {
        const command = row.command;
        if (!/claude/i.test(command) && !/tools cc run/i.test(command)) {
            return false;
        }

        // Skip our own helper greps / this command's process tree noise
        if (/\brg\b|\bgrep\b|teams discover|claude\/index\.ts teams|claude teams/.test(command)) {
            return false;
        }

        return true;
    });
}

function flagValue(cmd: string, flag: string): string | undefined {
    const re = new RegExp(`(?:^|\\s)${flag}(?:\\s+|=)([^\\s]+)`);
    const m = cmd.match(re);
    return m?.[1];
}

/**
 * Read selected env keys from a process. Expensive (`ps eww` per pid) — call
 * only for the few processes that need account attribution, never in a hot loop
 * over every claude on the machine.
 */
export function readProcessEnvKeys(pid: number, keys: string[]): Record<string, string> {
    const out: Record<string, string> = {};
    try {
        const result = psRunner(["ps", "eww", "-p", String(pid)]);

        // spawnSync reports an ordinary command failure through exitCode, not by
        // throwing — the process being gone, or ps refusing another user's env,
        // never reaches the catch below. An empty result is safe here (unlike the
        // process scan): callers read it as "account unknown" and fall back.
        if (result.exitCode !== 0) {
            logger.debug(
                { pid, exitCode: result.exitCode, stderr: result.stderr.trim() },
                "[teams] ps eww failed; account attribution skipped"
            );
            return out;
        }

        const text = result.stdout;
        for (const key of keys) {
            const re = new RegExp(`(?:^|\\s)${key}=([^\\s]*)`);
            const m = text.match(re);
            if (m) {
                out[key] = m[1];
            }
        }
    } catch (error) {
        // Callers treat a missing key as "account unknown" and fall back, so a
        // ps that cannot even be spawned is degraded, not fatal.
        logger.debug({ error, pid }, "[teams] could not spawn ps eww; account attribution skipped");
    }

    return out;
}

interface TmuxPaneRow {
    session: string;
    paneId: string;
    paneIndex: number;
    pid: number;
    title: string;
    currentCommand: string;
}

function listTmuxPanes(): TmuxPaneRow[] {
    const tmux = resolveTmuxBin();
    try {
        const proc = Bun.spawnSync(
            [
                tmux,
                "list-panes",
                "-a",
                "-F",
                "#{session_name}\t#{pane_id}\t#{pane_index}\t#{pane_pid}\t#{pane_title}\t#{pane_current_command}",
            ],
            { stdout: "pipe", stderr: "pipe" }
        );

        if (proc.exitCode !== 0) {
            return [];
        }

        const rows: TmuxPaneRow[] = [];
        for (const line of proc.stdout.toString().split("\n")) {
            if (!line.trim()) {
                continue;
            }

            const [session, paneId, paneIndex, pid, title, currentCommand] = line.split("\t");
            rows.push({
                session,
                paneId,
                paneIndex: Number(paneIndex),
                pid: Number(pid),
                title: title ?? "",
                currentCommand: currentCommand ?? "",
            });
        }

        return rows;
    } catch (error) {
        logger.debug({ error }, "[teams] tmux list-panes failed");
        return [];
    }
}

/** Map a process pid to its tmux pane by walking ancestors against pane pids. */
function paneForPid(pid: number, panes: TmuxPaneRow[], allProcesses: PsRow[]): TmuxPaneRow | undefined {
    // Full process table is required — intermediate parents are zsh/bun, not "claude-like".
    const byPid = new Map(allProcesses.map((p) => [p.pid, p]));
    let cur: number | undefined = pid;
    const paneByPid = new Map(panes.map((p) => [p.pid, p]));

    for (let i = 0; i < 16 && cur; i++) {
        const hit = paneByPid.get(cur);
        if (hit) {
            return hit;
        }

        cur = byPid.get(cur)?.ppid;
    }

    return undefined;
}

export interface LiveProcessScan {
    processes: LiveTeammateProcess[];
    /**
     * True when the process table could not be read. An empty `processes` then
     * carries no information: "no match" must surface as UNKNOWN, never as dead.
     */
    failed: boolean;
}

/**
 * Live Claude processes that look like agent-team teammates or leads launched
 * via tools cc run / bare claude.
 */
export function listLiveTeammateProcesses(): LiveProcessScan {
    return prof.measure("listLiveTeammateProcesses", () => {
        const allProcesses = prof.measure("ps-ax", () => listAllProcesses());

        if (allProcesses === null) {
            return { processes: [], failed: true };
        }

        const processes = listClaudeLikeProcesses(allProcesses);
        const panes = prof.measure("tmux-list-panes", () => listTmuxPanes());
        const results: LiveTeammateProcess[] = [];

        for (const row of processes) {
            const cmd = row.command;
            // Prefer the actual claude binary line with --agent-id
            const agentId = flagValue(cmd, "--agent-id");
            const agentName = flagValue(cmd, "--agent-name");
            const teamName = flagValue(cmd, "--team-name");

            if (agentId && agentName && teamName) {
                // Prefer real binary rows over bun wrappers
                if (cmd.includes("tools cc run") || cmd.includes("bun run") || cmd.includes("index.ts")) {
                    continue;
                }

                if (!/claude(?:-code)?(?:\s|$)/.test(cmd) && !cmd.includes("claude-code-darwin")) {
                    if (!cmd.includes("tools cc run") && !cmd.includes("claude/index.ts")) {
                        continue;
                    }
                }

                const pane = paneForPid(row.pid, panes, allProcesses);
                // Skip ps eww here — account is resolved at launch time (was the
                // dominant cost when many claude PIDs were live).
                results.push({
                    pid: row.pid,
                    cmdline: cmd,
                    agentId,
                    agentName,
                    teamName,
                    model: flagValue(cmd, "--model"),
                    parentSessionId: flagValue(cmd, "--parent-session-id"),
                    tmuxSession: pane?.session,
                    tmuxPaneId: pane?.paneId,
                    tmuxPaneIndex: pane?.paneIndex,
                });
                continue;
            }

            // Lead candidates: interactive claude binary without --agent-id
            const isLeadClaude =
                !cmd.includes("--agent-id") &&
                !cmd.includes("claude mcp") &&
                !cmd.includes("tools claude") &&
                !cmd.includes("index.ts") &&
                !cmd.includes("bun run") &&
                (cmd.includes("claude-code-darwin") ||
                    cmd.includes("/.bun/bin/claude") ||
                    /(?:^|[/\s])claude(?:\s|$)/.test(cmd));

            if (!isLeadClaude) {
                continue;
            }

            const pane = paneForPid(row.pid, panes, allProcesses);
            results.push({
                pid: row.pid,
                cmdline: cmd,
                agentId: "team-lead",
                agentName: "team-lead",
                teamName: "",
                tmuxSession: pane?.session,
                tmuxPaneId: pane?.paneId,
                tmuxPaneIndex: pane?.paneIndex,
            });
        }

        return { processes: results, failed: false };
    });
}

export function matchLiveProcess(
    live: LiveTeammateProcess[],
    opts: {
        teamName: string;
        agentName: string;
        agentId?: string;
        isLead?: boolean;
        leadSessionId?: string;
    }
): LiveTeammateProcess | undefined {
    if (opts.isLead) {
        // Lead: any non-agent claude in the same tmux session as a teammate of this team
        const teammatePanes = live.filter(
            (p) =>
                p.agentName !== "team-lead" &&
                (p.teamName === opts.teamName || p.parentSessionId === opts.leadSessionId)
        );
        const sessions = new Set(teammatePanes.map((p) => p.tmuxSession).filter(Boolean));
        if (sessions.size === 0) {
            // fallback: parentSessionId match only if we can't find panes
            return live.find(
                (p) => p.agentName === "team-lead" && opts.leadSessionId && p.parentSessionId === opts.leadSessionId
            );
        }

        return live.find((p) => p.agentName === "team-lead" && p.tmuxSession && sessions.has(p.tmuxSession));
    }

    return live.find(
        (p) =>
            p.agentName === opts.agentName &&
            (p.teamName === opts.teamName ||
                p.agentId === opts.agentId ||
                (opts.leadSessionId && p.parentSessionId === opts.leadSessionId))
    );
}

export function matchLeadPane(opts: {
    teamName: string;
    leadSessionId?: string;
    live: LiveTeammateProcess[];
    teammates: TeamMemberView[];
}): { session: string; leadPaneId: string } | undefined {
    const fromTeammate = opts.teammates.find((t) => t.live?.tmuxSession)?.live;
    if (fromTeammate?.tmuxSession) {
        const lead = opts.live.find(
            (p) => p.agentName === "team-lead" && p.tmuxSession === fromTeammate.tmuxSession && p.tmuxPaneId
        );
        if (lead?.tmuxPaneId) {
            return { session: fromTeammate.tmuxSession, leadPaneId: lead.tmuxPaneId };
        }

        // Lead may not be tagged; pick pane 1 of that session
        return { session: fromTeammate.tmuxSession, leadPaneId: "" };
    }

    const lead = matchLiveProcess(opts.live, {
        teamName: opts.teamName,
        agentName: "team-lead",
        isLead: true,
        leadSessionId: opts.leadSessionId,
    });

    if (lead?.tmuxSession && lead.tmuxPaneId) {
        return { session: lead.tmuxSession, leadPaneId: lead.tmuxPaneId };
    }

    return undefined;
}

export function formatStatusBadge(status: TeamMemberView["status"]): string {
    switch (status) {
        case "running":
            return "● run";
        case "idle":
            return "● idle";
        case "not-logged-in":
            return "● auth";
        case "dead":
            return "○ dead";
        default:
            return "· ?";
    }
}
