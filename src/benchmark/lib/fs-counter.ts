import fs from "node:fs";
import { logger } from "@genesiscz/utils/logger";

const { log } = logger.scoped("benchmark-fs-counter");

type AnyFn = (...args: unknown[]) => unknown;

/** Synchronous `node:fs` methods worth counting in a scan-heavy hot loop. */
const SYNC_METHODS = [
    "accessSync",
    "closeSync",
    "existsSync",
    "lstatSync",
    "openSync",
    "readFileSync",
    "readSync",
    "readdirSync",
    "realpathSync",
    "statSync",
    "writeFileSync",
] as const;

/** The `fs.promises` variants, counted under a `promises.` prefix. */
const PROMISE_METHODS = ["access", "lstat", "open", "readFile", "readdir", "realpath", "stat", "writeFile"] as const;

export interface FsCounterResult<T> {
    result: T;
    /** Per-method counts, e.g. `{ statSync: 139741, "promises.readFile": 3 }`. */
    calls: Record<string, number>;
    total: number;
}

function patchMethods(
    target: Record<string, unknown>,
    names: readonly string[],
    prefix: string,
    bump: (key: string) => void
): () => void {
    const restores: (() => void)[] = [];

    for (const name of names) {
        const original = target[name];

        if (typeof original !== "function") {
            log.debug({ name, prefix }, "fs counter skipped a method that is not a function on this runtime");
            continue;
        }

        const call = original as AnyFn;
        const wrapper = (...args: unknown[]): unknown => {
            bump(`${prefix}${name}`);
            return call.apply(target, args);
        };
        // `realpathSync.native` and friends hang off the function object; copying
        // them keeps `fs.realpathSync.native(...)` working inside the window.
        Object.assign(wrapper, original);
        target[name] = wrapper;
        restores.push(() => {
            target[name] = original;
        });
    }

    return () => {
        for (const restore of restores) {
            restore();
        }
    };
}

/**
 * Count the `node:fs` calls `fn` makes.
 *
 * WHAT IS INTERCEPTED. The methods are replaced on the `node:fs` module object
 * and on `fs.promises`, so any call written as a member access is counted:
 *
 * ```ts
 * import fs from "node:fs";
 * fs.statSync(path);            // counted as statSync
 * await fs.promises.stat(path); // counted as promises.stat
 * ```
 *
 * WHAT IS NOT. An ES module named import binds to the function VALUE at import
 * time, so replacing the property afterwards cannot reach it:
 *
 * ```ts
 * import { statSync } from "node:fs";
 * statSync(path);               // NOT counted
 * ```
 *
 * The same applies to any module that captured a reference before the window
 * opened (`const stat = fs.statSync`), to `Bun.file()` and `Bun.write()`, which
 * are native, and to native addons. A count is therefore a FLOOR, not a total.
 * To measure a module that uses named imports, change it to `import fs from
 * "node:fs"` first, or measure it with `sampleProcess` instead.
 *
 * The patch is restored in a `finally`, so a throwing `fn` still leaves
 * `node:fs` untouched; the error propagates.
 */
export async function withFsCounter<T>(fn: () => Promise<T>): Promise<FsCounterResult<T>> {
    const calls: Record<string, number> = {};

    function bump(key: string): void {
        calls[key] = (calls[key] ?? 0) + 1;
    }

    const fsTarget = fs as unknown as Record<string, unknown>;
    const promisesTarget = fs.promises as unknown as Record<string, unknown>;
    const restoreSync = patchMethods(fsTarget, SYNC_METHODS, "", bump);
    const restorePromises = patchMethods(promisesTarget, PROMISE_METHODS, "promises.", bump);

    try {
        const result = await fn();
        const total = Object.values(calls).reduce((sum, n) => sum + n, 0);
        return { result, calls, total };
    } finally {
        restoreSync();
        restorePromises();
        log.debug({ methods: Object.keys(calls).length }, "fs counter restored the node:fs methods");
    }
}
