/**
 * Set by the `tools` wrapper on a tool it spawns and waits for: the id of that one run. The tool's failure watcher
 * copies it into any record it writes, so the wrapper can tell whether the tool already recorded its own end before
 * it records a signal death itself (launcher.ts). Kept tiny: the wrapper imports it on every run.
 */
export const RUN_ID_ENV = "GENESIS_TOOLS_RUN_ID";

/**
 * The run id the wrapper gave this process. It is removed from the env, so a tool this one starts does not write
 * records under the same id and make the wrapper skip a signal death it should record.
 */
export function takeRunId(processEnv: Record<string, string | undefined>): string | undefined {
    const runId = processEnv[RUN_ID_ENV]?.trim() || undefined;
    delete processEnv[RUN_ID_ENV];
    return runId;
}
