/**
 * Interactive shells by program name. Four private lists of these existed (the cmux command capture, the in-place
 * restore, the session close liveness check, the tmux snapshot) and each knew a different subset, so `dash` was a
 * shell to one and a command to another.
 */
const SHELL_PROGRAMS: ReadonlySet<string> = new Set(["zsh", "bash", "sh", "fish", "dash", "ksh", "tcsh", "nu"]);

/** The program a command line or process name runs: the base name of its first word, without a login shell's `-`. */
export function programName(command: string): string {
    const first = command.trim().split(/\s+/, 1)[0] ?? "";
    return (first.split(/[/\\]/).pop() ?? first).replace(/^-/, "");
}

/**
 * True when the command line or process name is an interactive shell (`zsh`, `-zsh`, `/bin/bash -l`).
 * `orLogin` also accepts `login`, the root process macOS Terminal-style launchers put in front of the shell.
 */
export function isShellProgram(command: string, options: { orLogin?: boolean } = {}): boolean {
    const name = programName(command);
    return SHELL_PROGRAMS.has(name) || (options.orLogin === true && name === "login");
}
