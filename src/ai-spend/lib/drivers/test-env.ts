import { afterEach, beforeEach } from "bun:test";
import { env } from "@genesiscz/utils/env";
import type { EnvSnapshot } from "@genesiscz/utils/env/env-testing";

/**
 * Every agent driver honours a home override: `CLAUDE_CONFIG_DIR` adds a third
 * Claude root, `CODEX_HOME` and `GROK_HOME` relocate the Codex and Grok roots
 * entirely. A developer machine with any of them set would make a fixture-home
 * test walk REAL transcript trees, which both breaks exact root assertions and
 * inflates the file counts. Call this at the top of any suite that pins a
 * fixture home or an exact root list.
 */
const AGENT_HOME_KEYS = ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "GROK_HOME"] as const;

export function isolateAgentHomeEnv(): void {
    let snapshot: EnvSnapshot;

    beforeEach(() => {
        snapshot = env.testing.snapshot();

        for (const key of AGENT_HOME_KEYS) {
            env.testing.unset(key);
        }
    });

    afterEach(() => {
        env.testing.restore(snapshot);
    });
}
