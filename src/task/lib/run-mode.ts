export type RunModeChoice = "auto" | "pty" | "pipe";

export interface ResolveRunModeOptions {
    tty?: boolean;
    noTty?: boolean;
}

export function resolveRunMode(opts: ResolveRunModeOptions): "pty" | "pipe" {
    if (opts.tty && opts.noTty) {
        throw new Error("Cannot use --tty and --no-tty together.");
    }

    if (opts.tty) {
        if (process.platform === "win32") {
            throw new Error("--tty requires POSIX (macOS/Linux). Use --no-tty on Windows.");
        }

        return "pty";
    }

    if (opts.noTty) {
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
