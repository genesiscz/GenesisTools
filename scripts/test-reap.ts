/**
 * Reaping a stalled `bun test` coordinator and its workers.
 *
 * Extracted from `scripts/test.ts` so the parsing and the kill decision can be tested.
 * `scripts/test.ts` executes on import — it IS the runner — so nothing there is reachable
 * from a test file.
 *
 * 🛑 Like the rest of the `scripts/test-*` set, this module imports only `node:` builtins.
 * It runs BEFORE the dependency repair `scripts/test.ts` performs, so an import that reached
 * into `src/utils/**` would fail in exactly the broken-`node_modules` worktree the runner
 * exists to fix. That is why `startedAt` here is not shared with the near-identical helper in
 * `src/utils/bun/orphan-worker-guard.ts`: that one imports `../process-alive`, which pulls in
 * the tree that may not be installed yet.
 */

import { execFileSync } from "node:child_process";

/** One process, paired with the start time that proves it is still the same process. */
export interface Worker {
    pid: number;
    start: string;
}

/**
 * A full process table can be large on a busy machine, and `execFileSync` defaults to a 1 MiB
 * buffer. Overflowing it throws `ENOBUFS`, the catch returns an empty list, and the reap then
 * silently sweeps nothing while the coordinator is killed anyway — leaving the orphaned
 * workers this whole path exists to collect.
 */
const PS_MAX_BUFFER = 64 * 1024 * 1024;

/**
 * `ps` start time for `pid`, whitespace-normalised — the discriminator that separates
 * "this pid" from "a pid the kernel reissued to someone else".
 *
 * `kill -0` cannot do this: it succeeds for whoever holds the number now. The bun failure
 * mode this tripwire fires on burns hundreds of pids a second, so liveness is not identity.
 * Returns null when `ps` cannot answer, and the caller then declines to kill: refusing is
 * always safe, killing a stranger is not.
 */
export function startedAt(pid: number): string | null {
    try {
        const started = execFileSync("ps", ["-p", String(pid), "-o", "lstart="], {
            encoding: "utf8",
            maxBuffer: PS_MAX_BUFFER,
        })
            .replace(/\s+/g, " ")
            .trim();

        return started.length > 0 ? started : null;
    } catch {
        // `ps` exits non-zero for a pid that is already gone. That is the ordinary case here
        // and means the same to the caller as any other read failure: no identity, so no
        // kill. This file predates the dependency repair it performs, so it has no logger.
        return null;
    }
}

/**
 * Every descendant of `root` in a `ps -Ao pid=,ppid=,lstart=` table.
 *
 * Pure, so the walk is testable without spawning anything. A malformed line is skipped
 * rather than throwing: a partial table still names most of the workers, and naming most of
 * them beats naming none.
 */
export function descendantsFromTable(table: string, root: number): Worker[] {
    const children = new Map<number, number[]>();
    const starts = new Map<number, string>();

    for (const line of table.split("\n")) {
        const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);

        if (match === null) {
            continue;
        }

        const [, pidText, ppidText, startText] = match;

        if (pidText === undefined || ppidText === undefined || startText === undefined) {
            continue;
        }

        const pid = Number(pidText);
        const ppid = Number(ppidText);
        starts.set(pid, startText.replace(/\s+/g, " ").trim());
        const siblings = children.get(ppid);

        if (siblings === undefined) {
            children.set(ppid, [pid]);
        } else {
            siblings.push(pid);
        }
    }

    const found: Worker[] = [];
    const queue = [root];
    // A ppid cycle would otherwise loop forever. The kernel does not make them, but a
    // corrupted or truncated table can, and this walk runs while something is already wrong.
    const visited = new Set<number>([root]);

    while (queue.length > 0) {
        const next = queue.shift();

        if (next === undefined) {
            break;
        }

        for (const child of children.get(next) ?? []) {
            if (visited.has(child)) {
                continue;
            }

            visited.add(child);
            const start = starts.get(child);

            if (start !== undefined) {
                found.push({ pid: child, start });
            }

            queue.push(child);
        }
    }

    return found;
}

/**
 * Every descendant of `root`, each paired with the start time that proves its identity,
 * from ONE `ps` snapshot taken while `root` is still alive.
 *
 * It must be taken first, before the kill: the moment the coordinator dies its workers
 * reparent to pid 1 and the ppid chain that names them is gone for good.
 */
export function descendantsOf(root: number): Worker[] {
    let table: string;

    try {
        table = execFileSync("ps", ["-Ao", "pid=,ppid=,lstart="], {
            encoding: "utf8",
            maxBuffer: PS_MAX_BUFFER,
        });
    } catch {
        // No process table means nothing to walk. The coordinator kill below still happens;
        // only the descendant sweep is lost.
        return [];
    }

    return descendantsFromTable(table, root);
}

/** Seams, so a test can prove the kill decision without signalling a real process. */
export interface ReapDeps {
    /** Reads the live start time for a pid. Defaults to `startedAt`. */
    probe?: (pid: number) => string | null;
    /** Sends the signal. Defaults to `process.kill`. */
    kill?: (pid: number, signal: NodeJS.Signals) => void;
}

/**
 * SIGKILL each worker that is still the process the snapshot saw, and count the kills.
 *
 * Identity is re-checked immediately before every signal, against the start time captured
 * while the coordinator was alive. A pid reissued in between fails that check and is spared.
 */
export function reap(workers: Worker[], deps: ReapDeps = {}): number {
    const probe = deps.probe ?? startedAt;
    let killed = 0;

    for (const worker of workers) {
        if (probe(worker.pid) !== worker.start) {
            continue;
        }

        try {
            // The `probe(worker.pid) !== worker.start` check above runs immediately before
            // this signal, against the start time captured while the coordinator was alive.
            // A pid reissued in between fails it and is skipped. `process.kill` stays inline
            // rather than behind a default lambda, so the marker sits on the signalling line
            // itself and pid-safety-guard can see it.
            if (deps.kill) {
                deps.kill(worker.pid, "SIGKILL");
            } else {
                // pid-verified: start time re-checked against the live process one line earlier
                process.kill(worker.pid, "SIGKILL");
            }

            killed += 1;
        } catch {
            // The worker exited between the identity check and the signal, which is the
            // outcome this loop wanted. Nothing to report.
        }
    }

    return killed;
}
