import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { claudeSessionsDir } from "@genesiscz/utils/claude/peer-message";
import { runCmuxJSON } from "@genesiscz/utils/cmux/lib/cli";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { listPsTable, type PsRow, processBasename } from "@genesiscz/utils/process/ps";
import { shellWord } from "@genesiscz/utils/shell/quote";
import {
    listTmuxClients,
    listTmuxPanes,
    type TmuxClientInfo,
    type TmuxListing,
    type TmuxPaneInfo,
    type TmuxSocket,
    tmuxSocketFromCommand,
} from "@genesiscz/utils/tmux/sessions";

const { log } = logger.scoped("cmux-tmux-host");

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

/** A command line that resumes a session: `claude --resume <id>`, `claude -r <id>`, `--session-id <id>`, `codex resume <id>`. */
const RESUME_ID =
    /(?:^|\s)(?:--resume|--session-id|-r|resume)(?:=|\s+)['"]?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?![0-9a-f-])/gi;

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
    const list = map.get(key);

    if (!list) {
        map.set(key, [value]);
    } else if (!list.includes(value)) {
        list.push(value);
    }
}

/**
 * The processes that run each live session, keyed by lowercase session id.
 *
 * Claude's registry names the pid that owns a session right now (a `/resume` inside the TUI moves it), so it
 * wins. Only a session with no live registry entry is found by a command line that resumes its id, and never
 * through a pid the registry gives to another session. A command that only mentions an id (`rg <id>`, `tools
 * claude cmux focus <id>`) is not evidence: its tmux pane is somebody else's.
 */
export function sessionPidsBySession(
    processes: readonly HostProcess[],
    registry: ReadonlyMap<number, string>
): Map<string, number[]> {
    const commandOf = new Map(processes.map((proc) => [proc.pid, proc.command]));
    // A registry entry outlives its process; a recycled pid that runs something else is not the session.
    const liveOwner = new Map([...registry].filter(([pid]) => /claude/i.test(commandOf.get(pid) ?? "")));
    const found = new Map<string, number[]>();

    for (const [pid, sessionId] of liveOwner) {
        push(found, sessionId, pid);
    }

    const resumed = new Map<string, number[]>();

    for (const proc of processes) {
        for (const match of proc.command.matchAll(RESUME_ID)) {
            const sessionId = match[1].toLowerCase();

            if ((liveOwner.get(proc.pid) ?? sessionId) === sessionId) {
                push(resumed, sessionId, proc.pid);
            }
        }
    }

    for (const [sessionId, pids] of resumed) {
        if (!found.has(sessionId)) {
            found.set(sessionId, pids);
        }
    }

    return found;
}

/** The processes that run one session; see {@link sessionPidsBySession}. */
export function sessionProcessPids(
    sessionId: string,
    processes: readonly HostProcess[],
    registry: ReadonlyMap<number, string>
): number[] {
    return sessionPidsBySession(processes, registry).get(sessionId.toLowerCase()) ?? [];
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
 * Where live sessions run in tmux, keyed by lowercase session id: one entry per pane, with the clients attached
 * to that pane's tmux session. `only` limits it to one session.
 *
 * A session outside tmux, with no live process, or on a tmux that does not answer has no entry. Reads ONE
 * process table; tmux is asked only when a process sits under a tmux server, once per server, on its own socket.
 */
export async function findAllTmuxHosts(deps: TmuxHostDeps = {}, only?: string): Promise<Map<string, TmuxHost[]>> {
    const listProcesses = deps.listProcesses ?? (() => listPsTable());
    const readRegistry = deps.readRegistry ?? (() => readClaudeSessionRegistry());
    const listPanes = deps.listPanes ?? ((socket) => listTmuxPanes(undefined, { socket }));
    const listClients = deps.listClients ?? ((socket) => listTmuxClients({ socket }));

    const processes = await listProcesses();
    const byPid = new Map(processes.map((proc) => [proc.pid, proc]));
    const sessions = sessionPidsBySession(processes, readRegistry());
    const servers = new Map<number, { socket: TmuxSocket | undefined; sessionsByPanePid: Map<number, string[]> }>();

    for (const [sessionId, pids] of sessions) {
        if (only !== undefined && sessionId !== only.toLowerCase()) {
            continue;
        }

        for (const pid of pids) {
            const ancestor = tmuxPaneAncestor(pid, byPid);

            if (!ancestor) {
                continue;
            }

            const server = servers.get(ancestor.server.pid) ?? {
                socket: tmuxSocketFromCommand(ancestor.server.command),
                sessionsByPanePid: new Map<number, string[]>(),
            };
            push(server.sessionsByPanePid, ancestor.panePid, sessionId);
            servers.set(ancestor.server.pid, server);
        }
    }

    const hosts = new Map<string, TmuxHost[]>();

    if (servers.size === 0) {
        log.debug({ only, sessions: sessions.size }, "no session runs under a tmux server");
        return hosts;
    }

    for (const { socket, sessionsByPanePid } of servers.values()) {
        const [panes, clients] = await Promise.all([listPanes(socket), listClients(socket)]);

        if (!panes.ok || !clients.ok) {
            log.debug(
                { socket, panes: panes.ok ? null : panes.reason, clients: clients.ok ? null : clients.reason },
                "tmux did not answer; the clients of its sessions are unknown"
            );
            continue;
        }

        for (const pane of panes.items) {
            const owners = pane.panePid === undefined ? undefined : sessionsByPanePid.get(pane.panePid);

            for (const sessionId of owners ?? []) {
                push(hosts, sessionId, {
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
    }

    log.debug({ only, hosts: Object.fromEntries(hosts) }, "tmux hosts of live sessions");
    return hosts;
}

/** Where one session runs in tmux; see {@link findAllTmuxHosts}. */
export async function findTmuxHosts(sessionId: string, deps: TmuxHostDeps = {}): Promise<TmuxHost[]> {
    return (await findAllTmuxHosts(deps, sessionId)).get(sessionId.toLowerCase()) ?? [];
}

/** The command that attaches a terminal to a host's tmux session, as a person pastes it into a shell. */
export function tmuxAttachCommand(host: TmuxHost): string {
    return host.socket
        ? `tmux ${host.socket.flag} ${shellWord(host.socket.value)} attach -t ${shellWord(host.session)}`
        : `tools tmux session attach ${shellWord(host.session)}`;
}

/** A cmux terminal tab, from `cmux --id-format both tree --all --json`, keyed by what joins it to tmux: its tty. */
export interface CmuxTerminal {
    /** `ttys001`, without `/dev/`. */
    tty: string;
    surfaceRef: string | null;
    surfaceId: string | null;
    paneRef: string | null;
    workspaceRef: string | null;
    workspaceId: string | null;
    windowRef: string | null;
}

function text(value: unknown): string | null {
    return typeof value === "string" && value !== "" ? value : null;
}

function list(value: unknown): unknown[] {
    return Array.isArray(value) ? value : [];
}

/** `/dev/ttys001` (tmux) and `ttys001` (cmux) name the same terminal. */
export function ttyName(tty: string | null | undefined): string {
    return (tty ?? "").replace(/^\/dev\//, "");
}

/** Every terminal tab of a cmux tree that has a tty. */
export function parseCmuxTerminals(tree: unknown): CmuxTerminal[] {
    const terminals: CmuxTerminal[] = [];

    for (const window of isRecord(tree) ? list(tree.windows) : []) {
        if (!isRecord(window)) {
            continue;
        }

        for (const workspace of list(window.workspaces)) {
            if (!isRecord(workspace)) {
                continue;
            }

            for (const pane of list(workspace.panes)) {
                if (!isRecord(pane)) {
                    continue;
                }

                for (const surface of list(pane.surfaces)) {
                    const tty = isRecord(surface) ? ttyName(text(surface.tty)) : "";

                    if (
                        !isRecord(surface) ||
                        tty === "" ||
                        (surface.type !== undefined && surface.type !== "terminal")
                    ) {
                        continue;
                    }

                    terminals.push({
                        tty,
                        surfaceRef: text(surface.ref),
                        surfaceId: text(surface.id),
                        paneRef: text(surface.pane_ref) ?? text(pane.ref),
                        workspaceRef: text(workspace.ref),
                        workspaceId: text(workspace.id),
                        windowRef: text(window.ref),
                    });
                }
            }
        }
    }

    return terminals;
}

/** Where a session's tmux client runs in cmux, in the shape of the location the session hook records. */
export interface TmuxCmuxLocation {
    workspaceId: string | null;
    workspaceRef: string | null;
    paneRef: string | null;
    surfaceId: string | null;
    surfaceRef: string | null;
    windowRef: string | null;
    /** When it was read: a live answer, not a journal line. */
    at: number;
}

/** The optional `tree --all` answers in about 100 ms; a stalled cmux must not hold a session listing. */
const TREE_TIMEOUT_MS = 3_500;

/**
 * The cmux tab each live tmux-hosted session is shown in, keyed by lowercase session id.
 *
 * The hook records no cmux surface for a session started inside tmux (it inherits the tmux server's
 * environment), so a session list that reads only the journal says "no cmux pane" for a session that is on
 * screen. This joins it live: the session's tmux pane, the clients attached to that tmux session, and the cmux
 * tab whose tty runs one of them (a pane whose session is on screen first). cmux is asked only when some
 * session's tmux session has a client at all.
 */
export async function tmuxCmuxLocations(
    deps: TmuxHostDeps & { readTree?: () => Promise<unknown>; now?: number } = {}
): Promise<Map<string, TmuxCmuxLocation>> {
    const hosts = await findAllTmuxHosts(deps);
    const locations = new Map<string, TmuxCmuxLocation>();

    if (![...hosts.values()].some((entries) => entries.some((host) => host.clientTtys.length > 0))) {
        return locations;
    }

    const readTree =
        deps.readTree ??
        (() => runCmuxJSON<unknown>(["--id-format", "both", "tree", "--all"], { timeoutMs: TREE_TIMEOUT_MS }));
    let terminals: CmuxTerminal[];

    try {
        terminals = parseCmuxTerminals(await readTree());
    } catch (error) {
        log.debug({ error }, "cmux tree unreadable; tmux-hosted sessions get no cmux location");
        return locations;
    }

    const byTty = new Map(terminals.map((terminal) => [terminal.tty, terminal]));
    const at = deps.now ?? Date.now();

    for (const [sessionId, sessionHosts] of hosts) {
        const ordered = [...sessionHosts].sort((a, b) => Number(b.visible) - Number(a.visible));
        const terminal = ordered
            .flatMap((host) => host.clientTtys.map((tty) => byTty.get(ttyName(tty))))
            .find((candidate) => candidate !== undefined);

        if (terminal) {
            locations.set(sessionId, {
                workspaceId: terminal.workspaceId,
                workspaceRef: terminal.workspaceRef,
                paneRef: terminal.paneRef,
                surfaceId: terminal.surfaceId,
                surfaceRef: terminal.surfaceRef,
                windowRef: terminal.windowRef,
                at,
            });
        }
    }

    log.debug({ sessions: locations.size }, "cmux locations of tmux-hosted sessions");
    return locations;
}
