import { afterEach, beforeEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

/**
 * The grok roots also include the headless worker home, which hangs off
 * GENESIS_TOOLS_HOME rather than the fixture home. Unsetting it is not enough —
 * it falls back to the real `~/.genesis-tools`, whose worker sessions are
 * exactly the real tree this helper exists to keep out. It is pinned to a fresh
 * writable temp dir instead: empty, so nothing walks into it, and real, because
 * the same home is where caches get written.
 */
let fixtureToolsHome = "";

/** The GENESIS_TOOLS_HOME pinned for the current test. Valid inside a test body. */
export function toolsHomeFixture(): string {
    return fixtureToolsHome;
}

export function isolateAgentHomeEnv(): void {
    let snapshot: EnvSnapshot;

    beforeEach(() => {
        snapshot = env.testing.snapshot();

        for (const key of AGENT_HOME_KEYS) {
            env.testing.unset(key);
        }

        fixtureToolsHome = mkdtempSync(join(tmpdir(), "gt-spend-home-"));
        env.testing.set("GENESIS_TOOLS_HOME", fixtureToolsHome);
    });

    afterEach(() => {
        env.testing.restore(snapshot);
    });
}
