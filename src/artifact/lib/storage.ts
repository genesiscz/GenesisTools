import { resolve } from "node:path";
import { Storage } from "@genesiscz/utils/storage";

/**
 * The ONE place that names this tool's Storage. Every artifact module goes
 * through these accessors — never `new Storage("artifact")` elsewhere.
 *
 * Constructed per call, not at module level: Storage reads GENESIS_TOOLS_HOME
 * in its constructor, and the test sandbox sets that in beforeAll — after
 * imports. A module-level instance would capture the real home first.
 */
export function artifactStorage(): Storage {
    return new Storage("artifact");
}

/** Registered folders: ~/.genesis-tools/artifact/registry.json */
export function registryPath(): string {
    return resolve(artifactStorage().getBaseDir(), "registry.json");
}

/** Live dev servers: ~/.genesis-tools/artifact/running.json */
export function runningPath(): string {
    return resolve(artifactStorage().getBaseDir(), "running.json");
}
