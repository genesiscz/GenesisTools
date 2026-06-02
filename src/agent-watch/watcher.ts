import { logger, out } from "@app/logger";
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
        prevStates.set(snap.id, snap.state);

        if (!shouldNotify(prev, snap.state)) {
            continue;
        }

        const msg = transitionMessage(snap);

        try {
            await notifier.notify(msg);
            fired.push(snap);
        } catch (err) {
            logger.warn({ err, id: snap.id }, "notifier failed");
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

async function sweep(opts: RunWatchOptions, prevStates: Map<string, AgentState>): Promise<void> {
    const now = (opts.now ?? Date.now)();
    const snapshots = await collectSnapshots({ sources: opts.sources, now, stallTimeoutMs: opts.stallTimeoutMs });
    const fired = await decideAndNotify({ snapshots, prevStates, notifier: opts.notifier });

    for (const snap of fired) {
        const ts = new Date(now).toTimeString().slice(0, 8);
        out.log.step(`[${ts}] ${snap.name.padEnd(20)} → ${snap.state}  notified`);

        if (opts.json) {
            out.result({ ts: now, id: snap.id, name: snap.name, source: snap.source, state: snap.state });
        }
    }
}

export async function runWatch(opts: RunWatchOptions): Promise<void> {
    const prevStates = new Map<string, AgentState>();

    // Baseline pass: seed prevStates. On --once we still want the FIRST notable
    // states reported, so we run sweep (shouldNotify fires on undefined→notable).
    await sweep(opts, prevStates);

    if (opts.once) {
        return;
    }

    const roots = watchRootsFor(opts.sources);
    out.log.info(`watching ${roots.length} root(s) · stall-timeout ${opts.stallTimeoutMs / 1000}s`);

    const watcher = chokidar.watch(roots, { persistent: true, ignoreInitial: true, depth: 6 });
    let sweeping = false;

    const trigger = async (): Promise<void> => {
        if (sweeping) {
            return;
        }

        sweeping = true;

        try {
            await sweep(opts, prevStates);
        } finally {
            sweeping = false;
        }
    };

    watcher.on("change", trigger);
    watcher.on("add", trigger);

    // Poll re-sweep: a STALL is the ABSENCE of file events, so chokidar never
    // wakes us for it — we must re-classify on a timer to catch stalls/dead pids.
    const interval = setInterval(() => {
        void trigger();
    }, opts.pollMs);

    await new Promise<void>((resolve) => {
        const stop = (): void => {
            clearInterval(interval);
            void watcher.close();
            resolve();
        };

        process.once("SIGINT", stop);
        process.once("SIGTERM", stop);
    });
}
