/**
 * Set on a tool that `spawnToolDetached` starts. The `tools` wrapper then skips its orphan watchdog:
 * the caller exits at once on purpose, and the watchdog would stop the server about 2 s later.
 */
export const DETACHED_ENV = "GENESIS_TOOLS_DETACHED";

/**
 * Whether this `tools` run was started detached. The marker is removed from the env, so a `tools`
 * call the tool itself makes still gets the watchdog.
 */
export function takeDetachedMarker(processEnv: Record<string, string | undefined>): boolean {
    const detached = processEnv[DETACHED_ENV] === "1";
    delete processEnv[DETACHED_ENV];
    return detached;
}
