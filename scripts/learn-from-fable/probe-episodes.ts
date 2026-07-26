/**
 * Where the probes read mined episodes from when no path is passed on argv.
 * Resolved through the fable config so no probe carries a machine-specific path.
 */
import { join } from "node:path";
import { loadFableConfig, packPaths } from "../../src/learn-from-fable/lib/config";

const DEFAULT_ARTIFACT = "episodes.ai-proxy-martin-grok-grok-4.5.raw.jsonl";

export function defaultEpisodesPath(artifact = DEFAULT_ARTIFACT): string {
    const config = loadFableConfig();

    if (!config) {
        throw new Error(
            "No fable config found. Run `tools learn-from-fable bootstrap` or pass an episodes path as the last argument."
        );
    }

    return join(packPaths(config).episodesDir, artifact);
}
