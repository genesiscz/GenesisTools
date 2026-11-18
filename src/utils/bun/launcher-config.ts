import { resolve } from "node:path";
import { moduleDir } from "../fs/module-dir";
import { installedAppAccepts } from "../macos/genesis-app";
import { shellWordSpans } from "../shell/words";

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

/** A word whose value is `--config=` naming any checkout's launcher.bunfig.toml, with either path separator. */
function isLauncherConfigWord(value: string): boolean {
    return /^--config=.*[\\/]launcher\.bunfig\.toml$/.test(value);
}

/**
 * A saved command line (a daemon task registered with `launcherConfigFlag()`) as it should run now: without the flag
 * when the installed app predates it, as `launcherConfigArgs()` decides for a process started directly. Only a whole
 * word that is the flag goes; the same text inside another argument (`printf '%s' '--config=…'`) stays.
 */
export function launcherConfigForSavedCommand(commandLine: string): string {
    if (installedAppAccepts("launcher-config") !== false) {
        return commandLine;
    }

    let kept = commandLine;

    for (const word of shellWordSpans(commandLine).reverse()) {
        if (isLauncherConfigWord(word.value)) {
            const from = commandLine.slice(0, word.start).search(/\s*$/);
            kept = kept.slice(0, from) + kept.slice(word.end);
        }
    }

    return kept;
}

/**
 * Whether a bun command written into a file at install time (a launchd plist's text) disagrees with what the installed
 * app takes now: it carries `--config=` that the installed build refuses, or lacks it while the build accepts it. Such
 * a file was written for another build, so its service is installed again on its next user-triggered start.
 */
export function savedLauncherConfigIsStale(savedText: string): boolean {
    const accepts = installedAppAccepts("launcher-config");

    if (accepts === undefined) {
        return false;
    }

    return /--config=[^\s<>'"]*[\\/]launcher\.bunfig\.toml/.test(savedText) !== accepts;
}
