import { join } from "node:path";
import { env } from "@genesiscz/utils/env";

/**
 * `~/.genesis-tools/<segments>`. The root is `GENESIS_TOOLS_HOME` when it is set (tests sandbox
 * it there) and the real home otherwise, so production paths are unchanged.
 *
 * Imports no logger: a hook entrypoint on every Bash call can use it without paying for `Storage`.
 */
export function genesisToolsDir(...segments: string[]): string {
    return join(env.tools.getHome(), ".genesis-tools", ...segments);
}

/** `~/.genesis-tools/<tool>/<segments>`: the directory `new Storage(tool).getBaseDir()` returns. */
export function toolDataDir(tool: string, ...segments: string[]): string {
    return genesisToolsDir(tool, ...segments);
}
