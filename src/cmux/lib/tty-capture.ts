import { homedir } from "node:os";
import { agentOfCommand } from "@app/cmux/lib/tab-process";
import { listProcesses, readProcess } from "@genesiscz/utils/process/processes";
import { isShellProgram } from "@genesiscz/utils/shell/programs";

/**
 * The foreground command of each tab, read from the process table. Scrollback parsing cannot see the launch
 * command once a fullscreen TUI (claude, grok, vim) owns the pane, so the oldest non-shell process on the pane's
 * tty IS the command the user typed.
 */

// Interpolating homedir() into a fresh RegExp on every call recompiled it 10-60
// times per capture. The home directory does not change while the process runs.
const GROK_LOCAL_BIN_RE = new RegExp(`^${homedir()}/\\.local/bin/grok\\b`);

/** Normalize an absolute launcher path back to what the user actually types. */
export function cleanLaunchCommand(command: string): string {
    return command
        .replace(/^\S*\bbun (?:run )?\S*\/tools\s+/, "tools ")
        .replace(GROK_LOCAL_BIN_RE, "grok")
        .replace(/^\S*\/grok\b/, "grok")
        .trim();
}

interface TtyProcess {
    tty: string;
    /** Kernel start time in ms; an unknown one counts as now, the youngest. */
    startMs: number;
    command: string;
}

/**
 * Lowest pid first, as `ps` listed them, with the start time to the millisecond: a launcher and the agent it starts
 * begin in the same second, so whole seconds tied them and the kernel table's newest-first order picked the agent.
 */
async function readTtyProcessTable(): Promise<TtyProcess[]> {
    const now = Date.now();
    return listProcesses({ commands: false })
        .sort((a, b) => a.pid - b.pid)
        .flatMap((entry) => {
            if (!entry.tty || !/^ttys\d+$/.test(entry.tty)) {
                return [];
            }
            const command = readProcess(entry.pid)?.command;
            return command ? [{ tty: entry.tty, startMs: entry.startMs ?? now, command }] : [];
        });
}

export interface TtyCapture {
    /** tty → cleaned launch command (see `collectTtyLaunchCommands`). */
    launchCommands: Map<string, string>;
    /** tty → the Claude session id a `claude … --resume <uuid>` process on that tty runs. */
    claudeSessions: Map<string, string>;
}

/**
 * One process-table read, two answers per tty: the launch command the user
 * typed, and the Claude session a `claude --resume <uuid>` on that tty is
 * running. The argv is live truth for a resumed session, where the surface
 * journal can still carry the id of whatever ran in the pane before.
 */
export async function collectTtyCapture(): Promise<TtyCapture> {
    const oldest = new Map<string, TtyProcess>();
    const claudeSessions = new Map<string, string>();

    for (const entry of await readTtyProcessTable()) {
        const agent = agentOfCommand(entry.command);
        const sessionId = agent?.kind === "claude" ? agent.sessionId : undefined;
        if (sessionId && !claudeSessions.has(entry.tty)) {
            claudeSessions.set(entry.tty, sessionId);
        }

        if (isShellProgram(entry.command, { orLogin: true })) {
            continue;
        }

        const existing = oldest.get(entry.tty);
        if (!existing || entry.startMs < existing.startMs) {
            oldest.set(entry.tty, entry);
        }
    }

    const launchCommands = new Map<string, string>();
    for (const [tty, entry] of oldest) {
        launchCommands.set(tty, cleanLaunchCommand(entry.command));
    }

    return { launchCommands, claudeSessions };
}

/**
 * tty name (e.g. `ttys012`) → the cleaned launch command running on it.
 * The launch command is the OLDEST non-shell process on the tty (largest etime):
 * the shell comes first, the typed command next, and everything after is its
 * children. Pid ordering is NOT usable here — pids wrap, so a transient
 * `sleep 1` background job can carry a lower pid than the hours-old wrapper.
 */
export async function collectTtyLaunchCommands(): Promise<Map<string, string>> {
    return (await collectTtyCapture()).launchCommands;
}
