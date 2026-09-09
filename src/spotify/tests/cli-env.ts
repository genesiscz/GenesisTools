import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";

/**
 * The CLI test's environment, in place BEFORE any spotify module loads.
 *
 * `paths.ts` builds its `Storage` at import time from `GENESIS_TOOLS_HOME`, so this must be
 * a side-effect import at the top of the test file (biome never moves one across other
 * imports), not a statement after them. Everything the commands read or write lives under
 * `root`; the real profiles, cache and `~/.genesis-tools` are never reachable.
 */
export const root = mkdtempSync(join(tmpdir(), "spotify-cli-test-"));

const snapshot = env.testing.snapshot();

env.testing.set("GENESIS_TOOLS_HOME", root);
env.testing.set("SPOTIFY_CONFIG_PATH", join(root, "profiles.json"));
env.testing.set("SPOTIFY_CACHE_DIR", join(root, "cache"));
env.testing.set("NO_COLOR", "1");

/** Puts the process environment back, for the files that share this process after us. */
export function restoreCliEnv(): void {
    env.testing.restore(snapshot);
}
