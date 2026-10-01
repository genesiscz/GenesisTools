/**
 * How the `tools` wrapper hands control to a tool: replace itself (`execve`, same pid, no
 * wrapper left behind) or spawn a child and stay as its parent.
 *
 * Measured 2026-10-01: 33 idle wrappers at 25.6 MB each, 844 MB across the machine, every one
 * only waiting on its child. Exec is the default; the spawn path stays for every case where the
 * wrapper still has work after the child starts or exits:
 *
 * - a detached start (`spawnToolDetached`): its caller exits at once, and an exec'd launcher would
 *   take that as parent death and stop the server. The wrapper stays as the long-lived parent.
 * - a wrapper whose parent already died: the launcher's parent-death watch starts after the exec
 *   and would watch launchd instead, so the wrapper's poll stays in charge.
 * - a dependency tree that looks broken: only a living wrapper can read the child's stderr and
 *   offer `bun install` (the reinstall guard in `tools`).
 * - Windows, which has no exec that keeps the pid, and `GENESIS_TOOLS_NO_EXEC=1` (rollback).
 *
 * The other jobs the wrapper had move with the exec: the launcher forwards signals and stops its
 * child when its own parent dies (Launcher.swift `watchParentDeath`), and a worker started without
 * the launcher (from a GenesisTools app face) gets the orphan watchdog as a preload instead.
 */

export interface ToolExecInput {
    /** The GenesisTools.app launcher to go through, or null when this process skips it. */
    launcher: string | null;
    /** The named bun binary (`gt-<tool>`) that runs the tool. */
    execPath: string;
    /** Everything after the bun binary: preloads, the script, the tool's arguments. */
    bunArgs: string[];
    /** `src/utils/bun/preload-orphan-watchdog.ts`: the wrapper's orphan watchdog, inside the worker. */
    orphanWatchdogPreload: string;
    detached: boolean;
    /** The wrapper's parent is already gone (ppid 1). An exec'd launcher would watch launchd, not it. */
    orphaned: boolean;
    platform: NodeJS.Platform;
    /** `GENESIS_TOOLS_NO_EXEC=1`. */
    execDisabled: boolean;
    /** Why node_modules looks unusable (`diagnose()` in scripts/test-deps.ts), or null. */
    dependencyProblem: string | null;
}

export type ToolExecPlan =
    | { mode: "exec"; file: string; argv: string[] }
    | { mode: "spawn"; command: string; args: string[]; reason: string };

export function planToolExec(input: ToolExecInput): ToolExecPlan {
    const command = input.launcher ?? input.execPath;
    const args = input.launcher ? [input.execPath, ...input.bunArgs] : input.bunArgs;
    const spawn = (reason: string): ToolExecPlan => ({ mode: "spawn", command, args, reason });

    if (input.platform === "win32") {
        return spawn("windows has no exec that keeps the process");
    }

    if (input.execDisabled) {
        return spawn("GENESIS_TOOLS_NO_EXEC=1");
    }

    if (input.detached) {
        return spawn("detached start: the wrapper stays as the parent that outlives the caller");
    }

    if (input.orphaned) {
        return spawn("already orphaned: the wrapper's own watchdog stops the tool, as before");
    }

    if (input.dependencyProblem) {
        return spawn(`reinstall guard needs the child's stderr: ${input.dependencyProblem}`);
    }

    if (input.launcher) {
        return { mode: "exec", file: input.launcher, argv: [input.launcher, input.execPath, ...input.bunArgs] };
    }

    return {
        mode: "exec",
        file: input.execPath,
        argv: [input.execPath, "--preload", input.orphanWatchdogPreload, ...input.bunArgs],
    };
}
