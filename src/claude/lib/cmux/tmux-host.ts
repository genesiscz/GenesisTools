import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { claudeSessionsDir } from "@genesiscz/utils/claude/peer-message";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { listPsTable, type PsRow, processBasename } from "@genesiscz/utils/process/ps";
import {
    listTmuxClients,
    listTmuxPanes,
    type TmuxClientInfo,
    type TmuxListing,
    type TmuxPaneInfo,
    type TmuxSocket,
    tmuxSocketFromCommand,
} from "@genesiscz/utils/tmux/sessions";

const { log } = logger.scoped("claude-cmux-tmux");

export type HostProcess = Pick<PsRow, "pid" | "ppid" | "command">;

/**
 * The tmux pane a session's process runs in, and the terminals looking at it.
 *
 * A session started inside tmux descends from the tmux SERVER, not from the terminal that shows it, and it
 * inherits the server's environment. So neither its process tree nor its cmux env vars lead to the cmux pane:
 * only the clients attached to its tmux session do.
 */
export interface TmuxHost {
    /** The tmux session name (`dd-045c53d3`). */
    session: string;
    /** The tmux pane id (`%200`). */
    pane: string;
    /** The pane is the active pane of the session's current window, which is what every attached client shows. */
    visible: boolean;
    /** The ttys of the clients attached to that tmux session (`/dev/ttys001`). */
    clientTtys: string[];
    /** Set when the server is not the default one. */
    socket?: TmuxSocket;
}

export interface TmuxHostDeps {
    listProcesses?: () => Promise<HostProcess[]>;
    /** pid to session id, from Claude's live registry. */
    readRegistry?: () => Map<number, string>;
    listPanes?: (socket: TmuxSocket | undefined) => Promise<TmuxListing<TmuxPaneInfo>>;
    listClients?: (socket: TmuxSocket | undefined) => Promise<TmuxListing<TmuxClientInfo>>;
}

/** A process tree deeper than this is a loop in a stale table, not a real chain of parents. */
const ANCESTRY_LIMIT = 64;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

/**
 * pid to session id from Claude's live registry (`~/.claude/sessions/<pid>.json`). An entry can outlive its
 * process, so a caller checks the pid against the process table.
 */
export function readClaudeSessionRegistry(dir: string = claudeSessionsDir()): Map<number, string> {
    const registry = new Map<number, string>();
    let names: string[];

    try {
        names = readdirSync(dir);
    } catch (error) {
        log.debug({ error, dir }, "no Claude session registry");
        return registry;
    }

    for (const name of names) {
        if (!/^\d+\.json$/.test(name)) {
            continue;
        }

        try {
            const parsed: unknown = SafeJSON.parse(readFileSync(join(dir, name), "utf8"), { strict: true });

            if (isRecord(parsed) && typeof parsed.pid === "number" && typeof parsed.sessionId === "string") {
                registry.set(parsed.pid, parsed.sessionId.toLowerCase());
            }
        } catch (error) {
            log.debug({ error, name }, "unreadable Claude session registry file");
        }
    }

    return registry;
}

/** A command line that resumes this id: `claude --resume <id>`, `claude -r <id>`, `--session-id <id>`, `codex resume <id>`. */
function resumePattern(sessionId: string): RegExp {
    // A session id holds only hex digits and dashes, so it needs no escaping.
    return new RegExp(`(?:^|\\s)(?:--resume|--session-id|-r|resume)(?:=|\\s+)['"]?${sessionId}(?![0-9a-f-])`, "i");
}

/**
 * The processes that run this session.
 *
 * Claude's registry names the pid that owns the session right now (a `/resume` inside the TUI moves it), so it
 * wins. Only when it has no live entry does a command line that resumes the id count, and never a pid the
 * registry gives to another session. A command that only mentions the id (`rg <id>`, `tools claude cmux focus
 * <id>`) is not evidence: its tmux pane is somebody else's.
 */
export function sessionProcessPids(
    sessionId: string,
    processes: readonly HostProcess[],
    registry: ReadonlyMap<number, string>
): number[] {
    const id = sessionId.toLowerCase();
    const commandOf = new Map(processes.map((proc) => [proc.pid, proc.command]));
    // A recycled pid that runs something else is not the session any more.
    const owned = [...registry]
        .filter(([pid, owner]) => owner === id && /claude/i.test(commandOf.get(pid) ?? ""))
        .map(([pid]) => pid);

    if (owned.length > 0) {
        return owned;
    }

    const resume = resumePattern(id);
    return processes
        .filter((proc) => resume.test(proc.command) && (registry.get(proc.pid) ?? id) === id)
        .map((proc) => proc.pid);
}

/** A tmux client never has children, so a tmux process that is somebody's parent is a server. */
function isTmuxServer(proc: HostProcess): boolean {
    return /^tmux:?$/.test(processBasename(proc.command));
}

/** The pane a process runs in: its nearest ancestor (or itself) whose parent is a tmux server. Null outside tmux. */
export function tmuxPaneAncestor(
    pid: number,
    byPid: ReadonlyMap<number, HostProcess>
): { panePid: number; server: HostProcess } | null {
    let current = byPid.get(pid);

    for (let step = 0; current && step < ANCESTRY_LIMIT; step++) {
        const parent = byPid.get(current.ppid);

        if (!parent || parent.pid === current.pid) {
            return null;
        }

        if (isTmuxServer(parent)) {
            return { panePid: current.pid, server: parent };
        }

        current = parent;
    }

    return null;
}

/**
 * Where this session runs in tmux, one entry per pane, with the clients attached to each pane's session.
 *
 * Empty when the session runs outside tmux, has no live process, or tmux does not answer. Reads ONE process
 * table; tmux is asked only when a process sits under a tmux server, on that server's own socket.
 */
export async function findTmuxHosts(sessionId: string, deps: TmuxHostDeps = {}): Promise<TmuxHost[]> {
    const listProcesses = deps.listProcesses ?? (() => listPsTable());
    const readRegistry = deps.readRegistry ?? (() => readClaudeSessionRegistry());
    const listPanes = deps.listPanes ?? ((socket) => listTmuxPanes(undefined, { socket }));
    const listClients = deps.listClients ?? ((socket) => listTmuxClients({ socket }));

    const processes = await listProcesses();
    const byPid = new Map(processes.map((proc) => [proc.pid, proc]));
    const pids = sessionProcessPids(sessionId, processes, readRegistry());
    const servers = new Map<number, { socket: TmuxSocket | undefined; panePids: Set<number> }>();

    for (const pid of pids) {
        const ancestor = tmuxPaneAncestor(pid, byPid);

        if (!ancestor) {
            continue;
        }

        const server = servers.get(ancestor.server.pid) ?? {
            socket: tmuxSocketFromCommand(ancestor.server.command),
            panePids: new Set<number>(),
        };
        server.panePids.add(ancestor.panePid);
        servers.set(ancestor.server.pid, server);
    }

    if (servers.size === 0) {
        log.debug({ sessionId, pids }, "the session runs under no tmux server");
        return [];
    }

    const hosts: TmuxHost[] = [];

    for (const { socket, panePids } of servers.values()) {
        const [panes, clients] = await Promise.all([listPanes(socket), listClients(socket)]);

        if (!panes.ok || !clients.ok) {
            log.debug(
                { socket, panes: panes.ok ? null : panes.reason, clients: clients.ok ? null : clients.reason },
                "tmux did not answer; the session's tmux clients are unknown"
            );
            continue;
        }

        for (const pane of panes.items) {
            if (pane.panePid === undefined || !panePids.has(pane.panePid)) {
                continue;
            }

            hosts.push({
                session: pane.session,
                pane: pane.pane,
                visible: pane.visible,
                clientTtys: clients.items
                    .filter((client) => client.session === pane.session)
                    .map((client) => client.tty),
                ...(socket ? { socket } : {}),
            });
        }
    }

    log.debug({ sessionId, pids, hosts }, "tmux hosts of the session");
    return hosts;
}

/** The command that attaches a terminal to a host's tmux session. */
export function tmuxAttachCommand(host: TmuxHost): string {
    return host.socket
        ? `tmux ${host.socket.flag} ${host.socket.value} attach -t ${host.session}`
        : `tools tmux session attach ${host.session}`;
}
