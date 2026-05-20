import logger from "@app/logger";

/** Shared --verbose / --silent wiring for every `tools macos clones` command.
 *  --silent → only warn/error lines reach any stream (no INFO timing/benchmark
 *  noise on stderr); --verbose → debug+ reaches streams. Default unchanged. */
export function applyLogLevel(opts: { verbose?: boolean; silent?: boolean }): void {
    if (opts.silent) {
        logger.level = "warn";
    } else if (opts.verbose) {
        logger.level = "debug";
    }
}
