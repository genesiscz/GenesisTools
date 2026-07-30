import { join } from "node:path";
import { Storage } from "@genesiscz/utils/storage/storage";

/**
 * Resolve a path under the AI tool's data root (`~/.genesis-tools/ai`, or under
 * `GENESIS_TOOLS_HOME` when tests set it).
 *
 * This exists so code outside the config layer can put data next to the AI
 * config without constructing its own `Storage("ai")`. That call is fenced to
 * this directory by `scripts/ci/ai-credentials-guard.sh` rule 3 — the config
 * file has exactly one writer, and a second `Storage("ai")` anywhere else would
 * sidestep its lock order and migration chain. Reading a directory name is not
 * writing the config, so the accessor is the sanctioned way through.
 */
export function aiDataDir(...segments: string[]): string {
    const base = new Storage("ai").getBaseDir();

    return segments.length > 0 ? join(base, ...segments) : base;
}
