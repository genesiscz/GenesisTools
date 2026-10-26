import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, win32 } from "node:path";
import { env } from "@genesiscz/utils/env";
import { logger } from "@genesiscz/utils/logger";

/** Where Claude Code's installers put the binary when the shell that runs us has no PATH entry for it. */
export function claudeInstallLocations(home: string = homedir()): string[] {
    return [
        join(home, ".local", "bin", "claude"),
        join(home, ".claude", "local", "claude"),
        join(home, ".bun", "bin", "claude"),
        join(home, ".npm-global", "bin", "claude"),
        "/opt/homebrew/bin/claude",
        "/usr/local/bin/claude",
    ];
}

export interface FindClaudeExecutableDeps {
    which: (name: string) => string | null;
    isExecutable: (path: string) => boolean;
    /** `command -v claude` in the user's interactive shell, so a PATH set only in an rc file counts. */
    shellLookup: () => Promise<string | null>;
    home: string;
}

const SHELL_LOOKUP_TIMEOUT_MS = 3000;

/** Uses the user's rc files when Claude's PATH entry exists only in an interactive shell. */
function spawnShellLookup(shell: string) {
    return Bun.spawn({ cmd: [shell, "-ic", "command -v claude"], stdio: ["ignore", "pipe", "ignore"] });
}

/** Bounds shell startup, stdout and exit together; lookup failure only skips the optional CLI. */
export async function interactiveShellLookup(
    opts: { spawn?: typeof spawnShellLookup; timeoutMs?: number } = {}
): Promise<string | null> {
    const shell = env.paths.getShell("/bin/sh");
    let proc: ReturnType<typeof spawnShellLookup> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
        proc = (opts.spawn ?? spawnShellLookup)(shell);
        const [stdout] = await Promise.race([
            Promise.all([new Response(proc.stdout).text(), proc.exited]),
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error("timeout")), opts.timeoutMs ?? SHELL_LOOKUP_TIMEOUT_MS);
            }),
        ]);
        // An rc file may print to stdout; only a clean exit whose last line is an absolute path counts (an alias or
        // function name cannot be spawned).
        const last = stdout.trim().split("\n").pop()?.trim() ?? "";

        return proc.exitCode === 0 && (isAbsolute(last) || win32.isAbsolute(last)) ? last : null;
    } catch (error) {
        logger.debug({ error, shell }, "[findClaudeExecutable] interactive shell lookup failed");
        return null;
    } finally {
        clearTimeout(timer);
        proc?.kill();
    }
}

/** Follows installer symlinks, but rejects stale files and directories without spawning them. */
function isExecutable(path: string): boolean {
    try {
        accessSync(path, constants.X_OK);
        return statSync(path).isFile();
    } catch (error) {
        logger.debug({ error, path }, "[findClaudeExecutable] unusable install candidate");
        return false;
    }
}

const defaultDeps: FindClaudeExecutableDeps = {
    which: (name) => Bun.which(name),
    isExecutable,
    shellLookup: interactiveShellLookup,
    home: homedir(),
};

/**
 * The absolute path of the `claude` binary, or null when this Mac has none we can spawn. PATH first, then the
 * installers' own folders, then the user's interactive shell. `findClaudeCommand` answers a different question (the
 * shell command a user types, which may be an alias such as `ccc`); a `Bun.spawn` needs a real file.
 */
export async function findClaudeExecutable(deps: Partial<FindClaudeExecutableDeps> = {}): Promise<string | null> {
    const d = { ...defaultDeps, ...deps };
    const onPath = d.which("claude");

    if (onPath) {
        return onPath;
    }

    const installed = claudeInstallLocations(d.home).find((path) => d.isExecutable(path));

    if (installed) {
        logger.debug(
            { path: installed },
            "[findClaudeExecutable] claude is not on PATH, found it in an install folder"
        );
        return installed;
    }

    const fromShell = await d.shellLookup();
    logger.debug({ path: fromShell }, "[findClaudeExecutable] interactive shell lookup");

    return fromShell && d.isExecutable(fromShell) ? fromShell : null;
}
