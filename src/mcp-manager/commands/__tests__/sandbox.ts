import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll } from "bun:test";
import { Storage } from "@app/utils/storage";

/**
 * Sandbox every `new Storage(...)` for the duration of an mcp-manager test
 * file into a fresh tmp dir, so a leaked / cross-file-bled mock can never
 * write the user's real ~/.genesis-tools (this exact leak silently emptied
 * ~/.genesis-tools/mcp-manager/config.json during a full-suite run).
 *
 * Mechanism (defense in depth):
 *  1. `GENESIS_TOOLS_HOME` → fresh `mkdtemp` dir. `Storage`'s constructor
 *     reads this per instance (config.utils/config.ts are now lazy, so the
 *     redirect always takes effect at use time, not import time).
 *  2. SENTINEL: the write methods (`setConfig`/`setConfigValue`) are swapped
 *     for guards that THROW if `this.getBaseDir()` is not under the sandbox
 *     root — turning any future unsandboxed real-path write into a loud test
 *     failure instead of silent user data loss.
 *
 * Scoping: registered via per-file `beforeAll`/`afterAll`. bun runs test
 * files sequentially in one process, so the env + prototype swap exist ONLY
 * while this file's tests run and are fully reverted afterwards — other
 * tools' tests are unaffected (NOT a global bunfig preload, by design).
 *
 * Call once at the top of each mcp-manager test file (mirrors
 * `setupInquirerMock()`), before any dynamic `import("@app/mcp-manager/…")`.
 */
export function setupStorageSandbox(): void {
    let sandboxRoot = "";
    let prevEnv: string | undefined;
    const originals = new Map<string, (...args: unknown[]) => unknown>();

    const guard = (method: "setConfig" | "setConfigValue"): void => {
        const proto = Storage.prototype as unknown as Record<string, (...args: unknown[]) => unknown>;
        originals.set(method, proto[method]);
        const original = proto[method];
        proto[method] = function guarded(this: Storage, ...args: unknown[]): unknown {
            const base = this.getBaseDir();
            if (!base.startsWith(sandboxRoot)) {
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
        guard("setConfig");
        guard("setConfigValue");
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
