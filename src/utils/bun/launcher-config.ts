import { resolve } from "node:path";
import { moduleDir } from "../fs/module-dir";
import { installedAppAccepts } from "../macos/genesis-app";

/** The empty bunfig every GenesisTools bun process starts with (launcher.bunfig.toml says why it is empty). */
export const LAUNCHER_BUNFIG = resolve(moduleDir(import.meta), "launcher.bunfig.toml");

/**
 * The bun flag that keeps the working folder's bunfig.toml, and so its preloads, out of a process. GenesisTools.app
 * lets a bun process skip the vault window (a remembered or auto-allowed approval) only when it carries this flag:
 * without it, a preload of the folder's bunfig.toml can delete its file and change folder before the key is asked
 * for. Only the `=` form works; Bun 1.4.2 runs the argument after a bare `--config` as the program.
 */
export function launcherConfigFlag(bunfig = LAUNCHER_BUNFIG): string {
    return `--config=${bunfig}`;
}

/**
 * The flag as arguments for a process started now: none when the installed GenesisTools.app is a build that predates
 * it. Such a build treats `--config=` as foreign code and allows the process only once, and it checks the working
 * folder's bunfig.toml itself instead (2026-11-18 00:24: a worktree build replaced the install, and every `tools claude
 * embed`, `tools codex embed` and `tools say` start showed a once-only vault window).
 */
export function launcherConfigArgs(bunfig = LAUNCHER_BUNFIG): string[] {
    return installedAppAccepts("launcher-config") === false ? [] : [launcherConfigFlag(bunfig)];
}

/** `--config=` naming any checkout's launcher.bunfig.toml, bare or single-quoted as `shellQuote` writes it. */
const SAVED_LAUNCHER_CONFIG =
    /\s(?:--config=\S*\/launcher\.bunfig\.toml|'--config=[^']*\/launcher\.bunfig\.toml')(?=\s|$)/g;

/**
 * A saved command line (a daemon task registered with `launcherConfigFlag()`) as it should run now: without the flag
 * when the installed app predates it, as `launcherConfigArgs()` decides for a process started directly.
 */
export function launcherConfigForSavedCommand(commandLine: string): string {
    return installedAppAccepts("launcher-config") === false
        ? commandLine.replace(SAVED_LAUNCHER_CONFIG, "")
        : commandLine;
}
