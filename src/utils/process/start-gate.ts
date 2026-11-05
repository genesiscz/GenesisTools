import { randomUUID } from "node:crypto";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { logger } from "@genesiscz/utils/logger";
import { claimPidFile, clearPidFile, inspectPidFile } from "@genesiscz/utils/process/pidfile";

/**
 * A start gate: a spawner that waits for a detached child to start, and may give up, races that child for one
 * claim (`claimPidFile`'s atomic create), so exactly one of them wins. The child passes the gate right before its
 * work starts; the spawner closes it when its wait ends. A child that comes after the close finds the start
 * cancelled and does nothing, and a child that passed first is one the spawner knows by its pid.
 *
 * It exists because `movies.record` gave up after its wait while `tools recorder start`, still building ax-tool,
 * went on and recorded with no one to stop it (2026-11-05).
 */

/** The child's turn: go on, or the spawner gave up. */
export type StartGateTurn = { status: "passed" } | { status: "cancelled" };

/** The spawner's close: the child will not start, or it passed the gate (its pid when it still runs). */
export type StartGateClose = { status: "cancelled" } | { status: "passed"; pid: number | null };

/** Never take a claim over: whoever holds the gate, a live child or the spawner's mark, holds it for good. */
const never = (): boolean => false;

/** A new gate in `dir`, one per start. */
export function startGatePath(dir: string): string {
    return join(dir, `${randomUUID()}.gate`);
}

/**
 * The child, right before its work starts. Cancelled when the spawner closed the gate first; the child is then the
 * last reader, so it removes the spawner's mark.
 */
export async function passStartGate(path: string): Promise<StartGateTurn> {
    const claim = await claimPidFile(path, { reclaimable: never });

    if (claim.status === "claimed") {
        logger.debug({ path }, "[start-gate] passed");
        return { status: "passed" };
    }

    logger.info({ path, claim: claim.status }, "[start-gate] the spawner gave up waiting; not starting");
    clearPidFile(path, { force: true });
    return { status: "cancelled" };
}

/** The spawner, when its wait ends without the start it waited for. */
export async function closeStartGate(path: string): Promise<StartGateClose> {
    const claim = await claimPidFile(path, { reclaimable: never });

    if (claim.status === "claimed") {
        logger.info({ path }, "[start-gate] closed before the child came; it will not start");
        return { status: "cancelled" };
    }

    // Only a process confirmed to be the one that passed may be signalled; a recycled or unknown pid is never.
    const pid = claim.status === "held" && claim.state.status === "live" ? claim.state.pid : null;
    logger.info({ path, pid }, "[start-gate] the child passed the gate before the close");
    return { status: "passed", pid };
}

/**
 * The spawner's stop of a child that passed the gate but never started its work. The gate is read again right
 * before the signal, so a child that ended (it released its gate) or a recycled pid is never signalled.
 */
export function stopPassedChild({
    gate,
    pid,
    signal,
}: {
    gate: string;
    pid: number;
    signal: (pid: number) => void;
}): boolean {
    const state = inspectPidFile(gate);

    if (state.status !== "live" || state.pid !== pid) {
        logger.info(
            { gate, pid, state: state.status },
            "[start-gate] the child left its gate before the stop; not signalling"
        );
        return false;
    }

    signal(pid);
    return true;
}

/** The child, when its work ends: the gate goes with it. */
export function releaseStartGate(path: string): void {
    clearPidFile(path);
}

/** Gates older than `maxAgeMs` in `dir`: a child that died before it read its gate leaves one. */
export function sweepStartGates(dir: string, maxAgeMs: number, now = Date.now()): number {
    let removed = 0;
    let names: string[];

    try {
        names = readdirSync(dir).filter((name) => name.endsWith(".gate"));
    } catch (err) {
        logger.debug({ err, dir }, "[start-gate] no gate folder to sweep");
        return 0;
    }

    for (const name of names) {
        const path = join(dir, name);

        try {
            if (now - statSync(path).mtimeMs > maxAgeMs && clearPidFile(path, { force: true })) {
                removed++;
            }
        } catch (err) {
            logger.debug({ err, path }, "[start-gate] a gate went away while sweeping");
        }
    }

    return removed;
}

export interface AwaitStartOptions<T> {
    gate: string;
    /** The started work, once it shows (a live recording's entry); undefined while it has not. */
    find: () => T | undefined;
    timeoutMs: number;
    /** How long a child that passed the gate before the close may still take to show. */
    graceMs: number;
    pollMs: number;
    /** Ends a child that passed the gate but did not show within the grace. */
    stop: (pid: number) => void | Promise<void>;
}

export type StartOutcome<T> =
    /** It showed; `late` when only after the wait, from a child that had passed the gate. */
    | { status: "started"; value: T; late: boolean }
    /** Nothing passed the gate in time, and nothing will start later. */
    | { status: "cancelled" }
    /** A child passed the gate and never showed; it was stopped when its pid was known. */
    | { status: "stopped"; pid: number | null };

/** Polls `find` until `deadline`; undefined when it never answered. */
async function poll<T>(find: () => T | undefined, deadline: number, pollMs: number): Promise<T | undefined> {
    for (;;) {
        const value = find();

        if (value !== undefined || Date.now() >= deadline) {
            return value;
        }

        await Bun.sleep(Math.min(pollMs, Math.max(1, deadline - Date.now())));
    }
}

/** The spawner's wait: the start within the timeout, or the gate closed so a late child cannot start unseen. */
export async function awaitStart<T>(options: AwaitStartOptions<T>): Promise<StartOutcome<T>> {
    const value = await poll(options.find, Date.now() + options.timeoutMs, options.pollMs);

    if (value !== undefined) {
        return { status: "started", value, late: false };
    }

    const closed = await closeStartGate(options.gate);

    if (closed.status === "cancelled") {
        return { status: "cancelled" };
    }

    const late = await poll(options.find, Date.now() + options.graceMs, options.pollMs);

    if (late !== undefined) {
        return { status: "started", value: late, late: true };
    }

    if (closed.pid !== null) {
        await options.stop(closed.pid);
    }

    return { status: "stopped", pid: closed.pid };
}
