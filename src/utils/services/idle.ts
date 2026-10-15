import { logger } from "@genesiscz/utils/logger";
import { scanSockets } from "@genesiscz/utils/process/sockets";
import { Storage } from "@genesiscz/utils/storage";
import type { ServiceRow } from "./inventory";

/** Last time each running service had a client, keyed by `<id>@<startedAt>` so a new process starts fresh. */
export type IdleState = Record<string, number>;

export interface IdleDecision {
    row: ServiceRow;
    active: boolean;
    lastActive: number;
    stop: boolean;
}

/** The idle-state key of one running instance: a restarted server starts a fresh idle window. */
export function stateKey(row: ServiceRow): string {
    return `${row.id}@${row.startedAt ?? row.pid}`;
}

/**
 * Which services to stop: only detached ones with a port (a launchd job is installed to stay up, and
 * KeepAlive would only respawn it), and only once no client has been connected for `idleMs`. A
 * service seen for the first time counts as active now, so a fresh start always gets the full time.
 */
export function idleDecisions({
    rows,
    active,
    state,
    now,
    idleMs,
}: {
    rows: ServiceRow[];
    active: (row: ServiceRow) => boolean;
    state: IdleState;
    now: number;
    idleMs: number;
}): { decisions: IdleDecision[]; next: IdleState } {
    const next: IdleState = {};
    const decisions = rows
        .filter((row) => row.managed === "detached" && row.port !== null)
        .map((row) => {
            const key = stateKey(row);
            const isActive = active(row);
            const lastActive = isActive ? now : (state[key] ?? now);
            next[key] = lastActive;
            return { row, active: isActive, lastActive, stop: !isActive && now - lastActive >= idleMs };
        });
    return { decisions, next };
}

export function readClientPorts(): Set<number> | null {
    const sockets = scanSockets({ protocol: "TCP", state: "ESTABLISHED" });
    return sockets === null ? null : new Set(sockets.map((socket) => socket.port));
}

const storage = new Storage("services");

export async function readIdleState(): Promise<IdleState> {
    const state = (await storage.getConfigValue<IdleState>("activity")) ?? {};
    logger.debug({ tracked: Object.keys(state).length, file: storage.getConfigPath() }, "services: idle state read");
    return state;
}

export async function writeIdleState(state: IdleState): Promise<void> {
    await storage.setConfigValue("activity", state);
    logger.debug({ tracked: Object.keys(state).length }, "services: idle state saved");
}
