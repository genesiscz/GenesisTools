import { logger, out } from "@genesiscz/utils/logger";
import chokidar from "chokidar";
import { collectSnapshots, defaultClaudeRoot, defaultTaskDir, defaultWorkflowRoot } from "./sources/index";
import { shouldNotify, transitionMessage } from "./transitions";
import type { AgentSnapshot, AgentState, Notifier, WatchSourceName } from "./types";

export interface DecideAndNotifyInput {
    snapshots: AgentSnapshot[];
    prevStates: Map<string, AgentState>;
    notifier: Notifier;
}

/**
 * For each snapshot, compare its state to the remembered previous state and
 * notify on a notable transition. Mutates `prevStates` to the new states.
 * Returns the snapshots that fired (for the live status line).
 */
export async function decideAndNotify(input: DecideAndNotifyInput): Promise<AgentSnapshot[]> {
    const { snapshots, prevStates, notifier } = input;
    const fired: AgentSnapshot[] = [];

    for (const snap of snapshots) {
        const prev = prevStates.get(snap.id);

        if (!shouldNotify(prev, snap.state)) {
            prevStates.set(snap.id, snap.state);
            continue;
        }

        const msg = transitionMessage(snap);

        try {
            await notifier.notify(msg);
            // Commit the state only after the notify succeeds — a transient
            // notifier failure leaves prev unchanged so the next sweep retries.
            prevStates.set(snap.id, snap.state);
            fired.push(snap);
        } catch (err) {
            logger.warn({ err, id: snap.id }, "notifier failed; transition will retry on next sweep");
        }
    }

    return fired;
}

export interface RunWatchOptions {
    sources: WatchSourceName[];
    stallTimeoutMs: number;
    pollMs: number;
    notifier: Notifier;
    json: boolean;
    /** Drop agents inactive longer than this (ms). 0 = no filter. */
    activeWindowMs?: number;
    /** When set, do a single pass and resolve (cron / --once). */
    once?: boolean;
    /** Injected clock for determinism in any future test; defaults to Date.now. */
    now?: () => number;
}

function watchRootsFor(sources: WatchSourceName[]): string[] {
    const roots: string[] = [];

    if (sources.includes("task")) {
        roots.push(defaultTaskDir());
    }

    if (sources.includes("claude")) {
        roots.push(defaultClaudeRoot());
    }

    if (sources.includes("workflows")) {
        roots.push(defaultWorkflowRoot());
    }

    return roots;
}

const SILENT_NOTIFIER: Notifier = { notify: async () => {} };

export interface SweepInput {
    opts: RunWatchOptions;
    prevStates: Map<string, AgentState>;
    mode?: { notify: boolean };
}

export async function sweep(input: SweepInput): Promise<AgentSnapshot[]> {
    const { opts, prevStates, mode = { notify: true } } = input;
    const now = (opts.now ?? Date.now)();
    const snapshots = await collectSnapshots({
        sources: opts.sources,
        now,
        stallTimeoutMs: opts.stallTimeoutMs,
        activeWindowMs: opts.activeWindowMs,
    });
    const fired = await decideAndNotify({
        snapshots,
        prevStates,
        notifier: mode.notify ? opts.notifier : SILENT_NOTIFIER,
    });

    logger.debug(
        { sources: opts.sources, notify: mode.notify, snapshots: snapshots.length, fired: fired.length },
        "sweep complete"
    );

    if (!mode.notify) {
        return [];
    }

    for (const snap of fired) {
        const ts = new Date(now).toTimeString().slice(0, 8);
        out.log.step(`[${ts}] ${snap.name.padEnd(20)} → ${snap.state}  notified`);

        if (opts.json) {
            out.result({ ts: now, id: snap.id, name: snap.name, source: snap.source, state: snap.state });
        }
    }

    await out.flush();
    return fired;
}

export async function runWatch(opts: RunWatchOptions): Promise<void> {
    const prevStates = new Map<string, AgentState>();

    // Baseline pass. On --once (cron) currently-notable states within the active
    // window SHOULD fire (that's the single-shot's purpose). In continuous mode
    // the baseline only seeds prevStates — notifying on states that were already
    // notable before we started would replay history as a notification storm.
    await sweep({ opts, prevStates, mode: { notify: opts.once === true } });

    if (opts.once) {
        return;
    }

    const roots = watchRootsFor(opts.sources);
    out.log.info(`watching ${roots.length} root(s) · stall-timeout ${opts.stallTimeoutMs / 1000}s`);

    const watcher = chokidar.watch(roots, { persistent: true, ignoreInitial: true, depth: 6 });
    let sweeping = false;
    let resweepQueued = false;

    // An event landing DURING a sweep may describe a change the sweep already
    // missed — dropping it would delay (or lose) the transition until the next
    // poll. Queue exactly one follow-up sweep instead.
    const trigger = async (): Promise<void> => {
        if (sweeping) {
            resweepQueued = true;
            return;
        }

        sweeping = true;

        try {
            do {
                resweepQueued = false;
                await sweep({ opts, prevStates });
            } while (resweepQueued);
        } catch (err) {
            logger.warn({ err }, "agent-watch sweep failed");
        } finally {
            sweeping = false;
        }
    };

    watcher.on("change", trigger);
    watcher.on("add", trigger);
    watcher.on("error", (err) => {
        logger.error({ err }, "watcher error");
    });

    // Poll re-sweep: a STALL is the ABSENCE of file events, so chokidar never
    // wakes us for it — we must re-classify on a timer to catch stalls/dead pids.
    const interval = setInterval(() => {
        void trigger();
    }, opts.pollMs);

    await new Promise<void>((resolve) => {
        const stop = (): void => {
            clearInterval(interval);
            watcher
                .close()
                .catch((err) => {
                    logger.warn({ err }, "watcher close failed");
                })
                .finally(resolve);
        };

        process.once("SIGINT", stop);
        process.once("SIGTERM", stop);
    });
}
