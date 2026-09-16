import { logger } from "@genesiscz/utils/logger";

const { log } = logger.scoped("benchmark-spawn-counter");

type AnySpawn = (...args: unknown[]) => unknown;

export interface SpawnRecord {
    /** The argv as the callee received it, or `[]` when it could not be read. */
    cmd: string[];
    /** True for `Bun.spawnSync` and everything that funnels into it. */
    sync: boolean;
    /** Milliseconds since the counter started, not a wall-clock timestamp. */
    at: number;
}

export interface SpawnCounterResult<T> {
    result: T;
    count: number;
    spawns: SpawnRecord[];
}

function normalizeCmd(args: unknown[]): string[] {
    const first = args[0];

    if (Array.isArray(first)) {
        return first.map((part) => String(part));
    }

    if (typeof first === "object" && first !== null && "cmd" in first) {
        const cmd = (first as { cmd: unknown }).cmd;

        if (Array.isArray(cmd)) {
            return cmd.map((part) => String(part));
        }
    }

    return [];
}

/**
 * Count every child process `fn` starts.
 *
 * WHAT IS INTERCEPTED. Only `Bun.spawn` and `Bun.spawnSync` are patched, and
 * that is deliberate rather than partial: measured on bun 1.3.13, every
 * `node:child_process` entry point funnels into one of those two, so patching
 * the `node:child_process` methods as well would double-count.
 *
 * | Call                                          | Counted as        |
 * |-----------------------------------------------|-------------------|
 * | `Bun.spawn`, `Bun.spawnSync`                   | itself            |
 * | `child_process.exec` / `execFile` / `spawn`    | `Bun.spawn`       |
 * | `child_process.execSync` / `execFileSync`      | `Bun.spawnSync`   |
 * | `child_process.spawnSync`                      | `Bun.spawnSync`   |
 *
 * WHAT IS NOT. `Bun.$` (the Bun shell) reaches the OS through a native path
 * that never touches `Bun.spawn`, so its processes are invisible here. A count
 * is therefore a FLOOR for any code that uses `Bun.$`. Native addons and
 * `posix_spawn` from C are likewise invisible.
 *
 * The patch is restored in a `finally`, so a throwing `fn` still leaves
 * `Bun.spawn` untouched; the error propagates.
 *
 * ```ts
 * const { result, count } = await withSpawnCounter(() => collectTopProcesses(5));
 * // count === 1 proves the collector takes a top-N path instead of one ps per row.
 * ```
 */
export async function withSpawnCounter<T>(fn: () => Promise<T>): Promise<SpawnCounterResult<T>> {
    const spawns: SpawnRecord[] = [];
    const startedAt = performance.now();
    const savedSpawn = Bun.spawn;
    const savedSpawnSync = Bun.spawnSync;
    const callSpawn = savedSpawn as unknown as AnySpawn;
    const callSpawnSync = savedSpawnSync as unknown as AnySpawn;

    function record(args: unknown[], sync: boolean): void {
        spawns.push({ cmd: normalizeCmd(args), sync, at: performance.now() - startedAt });
    }

    Bun.spawn = ((...args: unknown[]) => {
        record(args, false);
        return callSpawn(...args);
    }) as unknown as typeof Bun.spawn;

    Bun.spawnSync = ((...args: unknown[]) => {
        record(args, true);
        return callSpawnSync(...args);
    }) as unknown as typeof Bun.spawnSync;

    try {
        const result = await fn();
        return { result, count: spawns.length, spawns };
    } finally {
        Bun.spawn = savedSpawn;
        Bun.spawnSync = savedSpawnSync;
        log.debug({ count: spawns.length }, "spawn counter restored Bun.spawn and Bun.spawnSync");
    }
}
