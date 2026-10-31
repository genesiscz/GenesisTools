/** A flag the launcher also sets, given by the user after `--`: theirs wins, ours is left out. */
export type LauncherFlag = "--effort" | "--model" | "--settings";

/** Whether the user's passthrough arguments set `flag` (as `--flag value` or `--flag=value`). */
export function passthroughSets(passthrough: readonly string[], flag: LauncherFlag): boolean {
    return passthrough.some((arg) => arg === flag || arg.startsWith(`${flag}=`));
}
