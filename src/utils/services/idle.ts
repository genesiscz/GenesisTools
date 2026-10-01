import { logger } from "@genesiscz/utils/logger";
import { type CaptureResult, captureSync } from "@genesiscz/utils/process/ps";
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

/**
 * The local port of every established connection in `lsof -Fn` output: an open browser tab keeps a
 * dev server's socket, whose local side is the server's port.
 */
export function connectedPorts(stdout: string): Set<number> {
    const ports = new Set<number>();

    for (const line of stdout.split("\n")) {
        if (!line.startsWith("n") || !line.includes("->")) {
            continue;
        }

        const local = line.slice(1, line.indexOf("->"));
        const port = Number(local.slice(local.lastIndexOf(":") + 1));

        if (Number.isInteger(port)) {
            ports.add(port);
        }
    }

    return ports;
}

/**
 * The ports with a connected client, from one `lsof` run. lsof exits 1 with no output when there is
 * nothing to list; any other failure gives null, so an unreadable machine never reads as "nobody is
 * connected" and stops a server in use.
 */
export function clientPortsFrom(run: CaptureResult): Set<number> | null {
    const nothingToList = run.status === 1 && run.stdout.trim() === "" && run.stderr.trim() === "";

    if (run.status !== 0 && !nothingToList) {
        logger.warn(
            { status: run.status, stderr: run.stderr.trim().slice(0, 500) },
            "services: lsof could not list connections"
        );
        return null;
    }

    return connectedPorts(run.stdout);
}

export function readClientPorts(): Set<number> | null {
    // lsof can hang on an unresponsive mount: past the deadline it is killed (status null), which
    // `clientPortsFrom` reads as unknown, never as idle.
    const ports = clientPortsFrom(
        captureSync("lsof", ["-nP", "-iTCP", "-sTCP:ESTABLISHED", "-Fn"], { timeoutMs: 10_000 })
    );
    logger.debug({ ports: ports ? [...ports] : null }, "services: client check");
    return ports;
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
