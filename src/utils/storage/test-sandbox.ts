import { afterAll, beforeAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { Storage } from "./storage";

// Every Storage method that writes under baseDir. The sentinel guards ALL
// of them (not just setConfig) so no write path can reach the real
// ~/.genesis-tools (PR #177 review t2).
const GUARDED_WRITE_METHODS = [
    "setConfig",
    "setConfigValue",
    "clearConfig",
    "putCacheFile",
    "deleteCacheFile",
    "clearCache",
    "putRawFile",
    "atomicUpdate",
    "atomicConfigUpdate",
    "ensureDirs",
] as const;

// True iff `target` is inside (or equal to) `root` — a real path-boundary
// check, NOT a string prefix (prefix would wrongly accept "/tmp/sbX-evil"
// for root "/tmp/sbX") (PR #177 review t1).
function isInside(root: string, target: string): boolean {
    const rel = relative(root, target);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Generic, reusable test util: sandbox every `new Storage(...)` for the
 * duration of a test file into a fresh tmp dir, so a leaked / cross-file-bled
 * mock can never write the user's real ~/.genesis-tools. (This exact leak
 * silently emptied ~/.genesis-tools/mcp-manager/config.json during a
 * full-suite run — see PR #177.) Any tool's tests that touch `Storage` can
 * opt in.
 *
 * Mechanism (defense in depth):
 *  1. `GENESIS_TOOLS_HOME` → fresh `mkdtemp` dir. `Storage`'s constructor
 *     reads this per instance, so callers that build `Storage` lazily (at
 *     use time, not import time) are redirected automatically.
 *  2. SENTINEL: the write methods (`setConfig`/`setConfigValue`) are swapped
 *     for guards that THROW if `this.getBaseDir()` is not under the sandbox
 *     root — turning any future unsandboxed real-path write into a loud test
 *     failure instead of silent user data loss.
 *
 * Scoping: registered via per-file `beforeAll`/`afterAll`. bun runs test
 * files sequentially in one process, so the env + prototype swap exist ONLY
 * while the importing file's tests run and are fully reverted afterwards —
 * other tools' tests are unaffected (NOT a global bunfig preload, by design,
 * since that would redirect every tool's Storage process-wide).
 *
 * Usage: create a thin `setup.ts` next to the test files that does
 * `import { setupStorageSandbox } from "@app/utils/storage/test-sandbox";
 * setupStorageSandbox();`, then `import "./setup.js";` once per test file
 * (jest-setupFiles style) — before any dynamic `import()` of the
 * Storage-backed module under test.
 */
export function setupStorageSandbox(): void {
    let sandboxRoot = "";
    let prevEnv: string | undefined;
    const originals = new Map<string, (...args: unknown[]) => unknown>();

    const guard = (method: string): void => {
        const proto = Storage.prototype as unknown as Record<string, (...args: unknown[]) => unknown>;
        const original = proto[method];
        if (typeof original !== "function") {
            return;
        }

        originals.set(method, original);
        proto[method] = function guarded(this: Storage, ...args: unknown[]): unknown {
            const base = this.getBaseDir();
            if (!isInside(sandboxRoot, base)) {
                throw new Error(
                    `Storage sandbox violation: ${method}() targeted "${base}" which is OUTSIDE the test sandbox "${sandboxRoot}". A mock leaked or an unsandboxed Storage was constructed — refusing to touch the real ~/.genesis-tools.`
                );
            }

            return original.apply(this, args);
        };
    };

    beforeAll(() => {
        prevEnv = process.env.GENESIS_TOOLS_HOME;
        sandboxRoot = mkdtempSync(join(tmpdir(), "gt-mcp-sandbox-"));
        process.env.GENESIS_TOOLS_HOME = sandboxRoot;
        for (const m of GUARDED_WRITE_METHODS) {
            guard(m);
        }
    });

    afterAll(() => {
        const proto = Storage.prototype as unknown as Record<string, (...args: unknown[]) => unknown>;
        for (const [method, fn] of originals) {
            proto[method] = fn;
        }

        originals.clear();

        if (prevEnv === undefined) {
            delete process.env.GENESIS_TOOLS_HOME;
        } else {
            process.env.GENESIS_TOOLS_HOME = prevEnv;
        }

        if (sandboxRoot) {
            rmSync(sandboxRoot, { recursive: true, force: true });
        }
    });
}
