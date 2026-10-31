import { beforeEach } from "bun:test";
import { env } from "@genesiscz/utils/env";
import { nativeHomeOverrideVariable } from "@genesiscz/utils/providers/session-paths";

/**
 * The test preload points `CLAUDE_CONFIG_DIR` and `GROK_HOME` at empty folders (`isolateNativeHomes` in
 * `src/utils/bun/preload-test-sandbox.ts`), so no test reads this Mac's real agent homes by accident. A file that
 * checks how the DEFAULT home resolves (no override set) calls this once at its top level: each of its tests starts
 * with both variables unset, and the preload puts the sandbox back after each one.
 */
export function startWithDefaultNativeHomes(): void {
    beforeEach(() => {
        env.testing.unset(nativeHomeOverrideVariable("claude"));
        env.testing.unset(nativeHomeOverrideVariable("grok"));
    });
}
