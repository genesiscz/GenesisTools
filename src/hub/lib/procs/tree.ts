import type { PsRow } from "@genesiscz/utils/process/ps";
import { type AgentProvider, classifyCommand, type ProcClass, type ProcKind } from "./classify";

/**
 * The hub's agent resource monitor, as data: every agent CLI session with its whole process tree
 * (MCP servers, tool shells, `tools` children), the GenesisTools wrappers that started them, and the
 * orphans (an agent, MCP server, tool shell or wrapper whose parent is gone, so launchd adopted it).
 * Built from ONE process table; everything else (cwd, sessions, launchd jobs, energy) is injected.
 */

/** A group whose session wrote nothing for this long, and whose tree uses almost no CPU, is idle. */
export const IDLE_AFTER_MS = 2 * 60 * 60_000;
/** A wrapper with no agent below it for this long is left over (an agent that exited, a picker nobody answered). */
export const WRAPPER_LEFTOVER_MS = 10 * 60_000;
const IDLE_CPU = 1;

export interface ProcEntry {
    pid: number;
    ppid: number;
    /** 0 for the group's root. */
    depth: number;
    kind: ProcKind;
    label: string;
    command: string;
    /** `ps` %cpu: a decayed average over the last minute or so, not an instant rate. */
    cpu: number;
    rssKb: number;
    /** macOS `top` POWER (energy impact), when asked for and the pid made the sample; else null. */
    energy: number | null;
    startedAt: string | null;
    state: string;
}

export interface ProcSessionMatch {
    provider: string;
    sessionId: string;
    title: string | null;
    /** Epoch ms of the session file's last write; null when the listing did not have it. */
    lastActivityAt: number | null;
    /** How it was matched: the argv, a tool shell's environment, or the newest session in the same folder. */
    match: "argv" | "shell" | "cwd";
}

export type GroupKind = "agent" | "wrapper" | "orphan";

export interface ProcGroup {
    /** `<kind>:<pid>`; stable while the root lives. */
    id: string;
    kind: GroupKind;
    rootPid: number;
    provider: AgentProvider | null;
    label: string;
    command: string;
    cwd: string | null;
    startedAt: string | null;
    ageMs: number | null;
    parent: { pid: number; label: string | null; alive: boolean };
    /** The GenesisTools wrapper (`tools claude run`) above an agent root. */
    wrapperPid: number | null;
    /** An agent root inside another agent's tree (a worker one session started). */
    parentAgentPid: number | null;
    orphan: boolean;
    /** Why it counts as an orphan, or why a PPID-1 process does not (a launchd job). */
    orphanReason: string | null;
    launchdLabel: string | null;
    idle: boolean;
    idleReason: string | null;
    session: ProcSessionMatch | null;
    /** The tree holds the process that asked (the hub's own `tools` call, or the agent session running it). */
    own: boolean;
    totals: { cpu: number; rssKb: number; energy: number | null; processes: number };
    processes: ProcEntry[];
}

export interface ProcsReport {
    groups: ProcGroup[];
    totals: { groups: number; orphans: number; idle: number; processes: number; cpu: number; rssKb: number };
    energy: boolean;
    takenAt: string;
    elapsedMs: number;
    warnings: string[];
}

/** A listed agent session, the fields the match needs (AgentSessionRow satisfies it). */
export interface SessionLike {
    provider: string;
    sessionId: string;
    title: string | null;
    cwd: string;
    mtime: number;
}

export interface BuildInput {
    table: PsRow[];
    now: number;
    /** The asking process and its ancestors. */
    own: Set<number>;
    /** Real path of a pid's cwd, or null. Called for group roots only. */
    cwdOf: (pid: number) => string | null;
    sessions: SessionLike[];
    /** Running launchd jobs: pid -> label. */
    launchd: Map<number, string>;
    /** pid -> `top` POWER; null when energy was not asked for. */
    energy: Map<number, number> | null;
    /** Resolve a folder the way `cwdOf` does, so session folders compare equal. */
    realpath: (path: string) => string;
}

interface Node {
    row: PsRow;
    cls: ProcClass;
}

function iso(date: Date | null): string | null {
    return date ? date.toISOString() : null;
}

function round(value: number): number {
    return Math.round(value * 10) / 10;
}

/** Every descendant of `pid`, depth-first, stopping at pids for which `stop` says so (their own groups). */
function walk(
    pid: number,
    children: Map<number, number[]>,
    stop: (pid: number) => boolean,
    depth = 1,
    out: Array<{ pid: number; depth: number }> = []
): Array<{ pid: number; depth: number }> {
    for (const child of children.get(pid) ?? []) {
        if (stop(child)) {
            continue;
        }

        out.push({ pid: child, depth });
        walk(child, children, stop, depth + 1, out);
    }

    return out;
}

export function buildProcsReport(input: BuildInput): Omit<ProcsReport, "elapsedMs" | "warnings"> {
    const nodes = new Map<number, Node>();
    const children = new Map<number, number[]>();

    for (const row of input.table) {
        nodes.set(row.pid, { row, cls: classifyCommand(row.command) });
    }

    for (const { row } of nodes.values()) {
        if (row.pid === row.ppid) {
            continue;
        }

        const list = children.get(row.ppid) ?? [];
        list.push(row.pid);
        children.set(row.ppid, list);
    }

    for (const list of children.values()) {
        list.sort((a, b) => a - b);
    }

    const kindOf = (pid: number): ProcKind | null => nodes.get(pid)?.cls.kind ?? null;
    const ancestors = (pid: number): number[] => {
        const chain: number[] = [];
        let current = nodes.get(pid)?.row.ppid;

        while (current !== undefined && current > 1 && !chain.includes(current) && chain.length < 64) {
            chain.push(current);
            current = nodes.get(current)?.row.ppid;
        }

        return chain;
    };

    // An agent whose direct parent is the same agent is its exec shim (the npm `codex.js` over the native
    // binary, a shell script over node): one session, not two.
    const isAgentRoot = (pid: number): boolean => {
        const node = nodes.get(pid);

        if (node?.cls.kind !== "agent") {
            return false;
        }

        const parent = nodes.get(node.row.ppid);
        return !(parent?.cls.kind === "agent" && parent.cls.provider === node.cls.provider);
    };

    const roots = new Map<number, GroupKind>();

    for (const pid of nodes.keys()) {
        if (isAgentRoot(pid)) {
            roots.set(pid, "agent");
        }
    }

    // Wrappers: the topmost one of a chain. Left over when no agent root sits below it and it is old enough.
    const agentBelow = (pid: number): boolean =>
        walk(pid, children, () => false).some((entry) => roots.get(entry.pid) === "agent");

    for (const [pid, node] of nodes) {
        if (node.cls.kind !== "wrapper" || kindOf(node.row.ppid) === "wrapper") {
            continue;
        }

        const age = node.row.startTime ? input.now - node.row.startTime.getTime() : 0;

        if (!agentBelow(pid) && (age >= WRAPPER_LEFTOVER_MS || node.row.ppid === 1)) {
            roots.set(pid, "wrapper");
        }
    }

    // Orphans: an MCP server or tool shell that launchd adopted, outside every agent tree.
    for (const [pid, node] of nodes) {
        if (node.row.ppid === 1 && (node.cls.kind === "mcp" || node.cls.kind === "shell") && !roots.has(pid)) {
            roots.set(pid, "orphan");
        }
    }

    const groups: ProcGroup[] = [];
    const takenSessions = new Set<string>();

    // Newest first, so the greedy folder match gives the newest session to the newest process.
    const ordered = [...roots.keys()].sort((a, b) => {
        const at = nodes.get(a)?.row.startTime?.getTime() ?? 0;
        const bt = nodes.get(b)?.row.startTime?.getTime() ?? 0;
        return bt - at;
    });

    // Explicit ids first: a folder match must not take a session some process names outright.
    for (const pid of ordered) {
        const node = nodes.get(pid);

        if (node?.cls.sessionId) {
            takenSessions.add(node.cls.sessionId);
        }
    }

    for (const pid of ordered) {
        const node = nodes.get(pid);
        const kind = roots.get(pid);

        if (!node || !kind) {
            continue;
        }

        const members = walk(pid, children, (child) => roots.get(child) === "agent");
        const entries: ProcEntry[] = [{ pid, depth: 0 }, ...members].flatMap(({ pid: member, depth }) => {
            const found = nodes.get(member);

            if (!found) {
                return [];
            }

            return [
                {
                    pid: member,
                    ppid: found.row.ppid,
                    depth,
                    kind: found.cls.kind,
                    label: found.cls.label,
                    command: found.row.command,
                    cpu: found.row.cpu,
                    rssKb: found.row.rss,
                    energy: input.energy ? (input.energy.get(member) ?? 0) : null,
                    startedAt: iso(found.row.startTime),
                    state: found.row.stat,
                },
            ];
        });

        const chain = ancestors(pid);
        const parentNode = nodes.get(node.row.ppid);
        const launchdLabel = input.launchd.get(pid) ?? null;
        const adopted = node.row.ppid === 1;
        const orphanReason = orphanWhy({ pid, kind, chain, nodes, launchd: input.launchd });
        const cwd = input.cwdOf(pid);
        const session = matchSession({ node, entries, nodes, cwd, input, takenSessions });

        if (session) {
            takenSessions.add(session.sessionId);
        }

        const cpu = round(entries.reduce((sum, entry) => sum + entry.cpu, 0));
        const startedAt = node.row.startTime;
        const ageMs = startedAt ? input.now - startedAt.getTime() : null;
        const idle = idleOf({ kind, cpu, ageMs, session, now: input.now });
        const ownTree = input.own.has(pid) || entries.some((entry) => input.own.has(entry.pid));

        groups.push({
            id: `${kind}:${pid}`,
            kind,
            rootPid: pid,
            provider: node.cls.provider,
            label: node.cls.label,
            command: node.row.command,
            cwd,
            startedAt: iso(startedAt),
            ageMs,
            parent: {
                pid: node.row.ppid,
                label: node.row.ppid === 1 ? "launchd" : (parentNode?.cls.label ?? null),
                alive: node.row.ppid === 1 ? false : parentNode !== undefined,
            },
            wrapperPid: kind === "agent" ? (chain.find((ancestor) => kindOf(ancestor) === "wrapper") ?? null) : null,
            parentAgentPid:
                kind === "agent" ? (chain.find((ancestor) => roots.get(ancestor) === "agent") ?? null) : null,
            orphan: orphanReason !== null,
            orphanReason:
                orphanReason ?? (adopted && launchdLabel ? `a launchd job (${launchdLabel}), not an orphan` : null),
            launchdLabel,
            idle: idle !== null,
            idleReason: idle,
            session,
            own: ownTree,
            totals: {
                cpu,
                rssKb: entries.reduce((sum, entry) => sum + entry.rssKb, 0),
                energy: input.energy ? round(entries.reduce((sum, entry) => sum + (entry.energy ?? 0), 0)) : null,
                processes: entries.length,
            },
            processes: entries,
        });
    }

    groups.sort(compareGroups);

    return {
        groups,
        totals: {
            groups: groups.length,
            orphans: groups.filter((group) => group.orphan).length,
            idle: groups.filter((group) => group.idle).length,
            processes: groups.reduce((sum, group) => sum + group.totals.processes, 0),
            cpu: round(groups.reduce((sum, group) => sum + group.totals.cpu, 0)),
            rssKb: groups.reduce((sum, group) => sum + group.totals.rssKb, 0),
        },
        energy: input.energy !== null,
        takenAt: new Date(input.now).toISOString(),
    };
}

/**
 * Why a group root counts as an orphan: launchd adopted it (PPID 1) and it is not a launchd job, or
 * launchd adopted the wrapper or agent that started it (a `tools claude run` whose terminal is gone).
 */
function orphanWhy({
    pid,
    kind,
    chain,
    nodes,
    launchd,
}: {
    pid: number;
    kind: GroupKind;
    chain: number[];
    nodes: Map<number, Node>;
    launchd: Map<number, string>;
}): string | null {
    const self = nodes.get(pid);

    if (self?.row.ppid === 1) {
        return launchd.has(pid) ? null : "its parent is gone (PPID 1)";
    }

    const top = chain[chain.length - 1];
    const topNode = top === undefined ? undefined : nodes.get(top);

    if (
        kind === "agent" &&
        top !== undefined &&
        topNode?.row.ppid === 1 &&
        (topNode.cls.kind === "wrapper" || topNode.cls.kind === "agent") &&
        !launchd.has(top)
    ) {
        return `the ${topNode.cls.label} that started it (${top}) lost its parent (PPID 1)`;
    }

    return null;
}

/** Orphans first, then by memory: the order someone hunting a hog reads in. */
function compareGroups(a: ProcGroup, b: ProcGroup): number {
    if (a.orphan !== b.orphan) {
        return a.orphan ? -1 : 1;
    }

    return b.totals.rssKb - a.totals.rssKb;
}

function idleOf({
    kind,
    cpu,
    ageMs,
    session,
    now,
}: {
    kind: GroupKind;
    cpu: number;
    ageMs: number | null;
    session: ProcSessionMatch | null;
    now: number;
}): string | null {
    if (cpu >= IDLE_CPU) {
        return null;
    }

    if (kind === "wrapper") {
        return "no agent process runs below it";
    }

    if (kind !== "agent") {
        return null;
    }

    if (session?.lastActivityAt) {
        const quiet = now - session.lastActivityAt;
        return quiet >= IDLE_AFTER_MS ? `its session wrote nothing for ${hours(quiet)}` : null;
    }

    return ageMs !== null && ageMs >= IDLE_AFTER_MS ? `no session activity found in ${hours(ageMs)}` : null;
}

function hours(ms: number): string {
    const value = ms / 3_600_000;
    return value >= 48 ? `${Math.round(value / 24)} days` : `${Math.round(value)} h`;
}

function matchSession({
    node,
    entries,
    nodes,
    cwd,
    input,
    takenSessions,
}: {
    node: Node;
    entries: ProcEntry[];
    nodes: Map<number, Node>;
    cwd: string | null;
    input: BuildInput;
    takenSessions: Set<string>;
}): ProcSessionMatch | null {
    const provider = node.cls.provider;
    const listed = (id: string) => input.sessions.find((session) => session.sessionId === id);
    const named = (id: string, match: ProcSessionMatch["match"]): ProcSessionMatch => {
        const hit = listed(id);
        return {
            provider: hit?.provider ?? provider ?? "claude",
            sessionId: id,
            title: hit?.title ?? null,
            lastActivityAt: hit?.mtime ?? null,
            match,
        };
    };

    if (node.cls.sessionId) {
        return named(node.cls.sessionId, node.cls.kind === "shell" ? "shell" : "argv");
    }

    // A Claude tool shell carries its session's id in its environment: the surest link there is.
    const shell = entries
        .map((entry) => nodes.get(entry.pid)?.cls)
        .find((cls) => cls?.kind === "shell" && cls.sessionId);

    if (shell?.sessionId) {
        return named(shell.sessionId, "shell");
    }

    if (node.cls.kind !== "agent" || !cwd || !provider) {
        return null;
    }

    const started = node.row.startTime?.getTime() ?? 0;
    const candidate = input.sessions
        .filter(
            (session) =>
                session.provider === provider &&
                !takenSessions.has(session.sessionId) &&
                session.cwd !== "" &&
                input.realpath(session.cwd) === cwd &&
                session.mtime >= started - 60_000
        )
        .sort((a, b) => b.mtime - a.mtime)[0];

    return candidate
        ? {
              provider: candidate.provider,
              sessionId: candidate.sessionId,
              title: candidate.title,
              lastActivityAt: candidate.mtime,
              match: "cwd",
          }
        : null;
}
