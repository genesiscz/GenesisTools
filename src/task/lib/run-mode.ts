export type RunModeChoice = "auto" | "pty" | "pipe";

export interface ResolveRunModeOptions {
    /** Commander sets `tty: false` for `--no-tty`, `true` for `--tty`, undefined for auto. */
    tty?: boolean;
}

export function resolveRunMode(opts: ResolveRunModeOptions): "pty" | "pipe" {
    if (opts.tty === true) {
        if (process.platform === "win32") {
            throw new Error("--tty requires POSIX (macOS/Linux). Use --no-tty on Windows.");
        }

        return "pty";
    }

    if (opts.tty === false) {
        return "pipe";
    }

    if (process.stdin.isTTY) {
        if (process.platform === "win32") {
            return "pipe";
        }

        return "pty";
    }

    return "pipe";
}

export function canUsePty(): boolean {
    return process.platform !== "win32";
}
