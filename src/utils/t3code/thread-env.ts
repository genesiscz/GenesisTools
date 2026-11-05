import { homedir } from "node:os";
import { join } from "node:path";

/**
 * The T3 Code thread a caller runs in. T3 Code passes its own thread id to every provider child it starts
 * (`T3CODE_THREAD_ID`, apps/server PortScanner.ts and ClaudeAdapterV2.ts in the T3 Code source; observed in a live
 * Codex child, research note 2026-11-04), and every descendant inherits it. The id is opaque and is the HOST's thread,
 * never the provider's session id. No I/O.
 */
export function readT3Thread(env: NodeJS.ProcessEnv): string | undefined {
    const id = env.T3CODE_THREAD_ID?.trim();
    return id ? id : undefined;
}

/** The variables the T3 Code readers look at: the thread, and the home whose store holds its details. */
export const T3_CALLER_ENV_KEYS = ["T3CODE_THREAD_ID", "T3CODE_HOME"] as const;

/** T3 Code's home: `T3CODE_HOME` when the caller's environment names one, else `~/.t3`. */
export function t3Home(env: NodeJS.ProcessEnv, home = homedir()): string {
    return env.T3CODE_HOME?.trim() || join(home, ".t3");
}
