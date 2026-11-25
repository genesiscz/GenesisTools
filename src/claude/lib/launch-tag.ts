import { randomUUID } from "node:crypto";

/**
 * The two variables `tools claude run` gives the claude it starts. The SessionStart hook
 * (`plugins/genesis-tools/hooks/record-session-account.ts`, `launchIdFor`) reads them by these names, since it cannot
 * import this module, and writes the id into the session's pin when the launcher's pid is right above that claude.
 * `sessionOfLaunch` (`@genesiscz/utils/agent-sessions/pins`) then names the session the launch ran.
 */
export const LAUNCH_ID_ENV = "TOOLS_CLAUDE_LAUNCH_ID";
export const LAUNCHER_PID_ENV = "TOOLS_CLAUDE_LAUNCHER_PID";

export interface LaunchTag {
    id: string;
    launcherPid: number;
}

export function newLaunchTag(): LaunchTag {
    return { id: randomUUID(), launcherPid: process.pid };
}

/**
 * The env of a launch with its own tag, or with no tag at all. A tag inherited from an outer launch (a `tools claude run`
 * inside a session) is dropped either way: it names the other launch.
 */
export function withLaunchTag(
    launchEnv: Record<string, string | undefined>,
    tag: LaunchTag | null
): Record<string, string | undefined> {
    const next = { ...launchEnv };
    delete next[LAUNCH_ID_ENV];
    delete next[LAUNCHER_PID_ENV];

    if (tag) {
        next[LAUNCH_ID_ENV] = tag.id;
        next[LAUNCHER_PID_ENV] = String(tag.launcherPid);
    }

    return next;
}
