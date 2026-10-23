import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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
    exists: (path: string) => boolean;
    /** `command -v claude` in the user's interactive shell, so a PATH set only in an rc file counts. */
    shellLookup: () => Promise<string | null>;
    home: string;
}

const SHELL_LOOKUP_TIMEOUT_MS = 3000;

async function interactiveShellLookup(): Promise<string | null> {
    const shell = env.paths.getShell("/bin/sh");
    const proc = Bun.spawn({ cmd: [shell, "-ic", "command -v claude"], stdio: ["ignore", "pipe", "ignore"] });
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
        const stdout = await Promise.race([
            new Response(proc.stdout).text(),
            new Promise<string>((_, reject) => {
                timer = setTimeout(() => reject(new Error("timeout")), SHELL_LOOKUP_TIMEOUT_MS);
            }),
        ]);
        await proc.exited;
        // An rc file may print to stdout; only a clean exit whose last line is an absolute path counts (an alias or
        // function name cannot be spawned).
        const last = stdout.trim().split("\n").pop()?.trim() ?? "";

        return proc.exitCode === 0 && last.startsWith("/") && !/\s/.test(last) ? last : null;
    } catch (error) {
        logger.debug({ error, shell }, "[findClaudeExecutable] interactive shell lookup failed");
        return null;
    } finally {
        clearTimeout(timer);
        proc.kill();
    }
}

const defaultDeps: FindClaudeExecutableDeps = {
    which: (name) => Bun.which(name),
    exists: existsSync,
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

    const installed = claudeInstallLocations(d.home).find((path) => d.exists(path));

    if (installed) {
        logger.debug(
            { path: installed },
            "[findClaudeExecutable] claude is not on PATH, found it in an install folder"
        );
        return installed;
    }

    const fromShell = await d.shellLookup();
    logger.debug({ path: fromShell }, "[findClaudeExecutable] interactive shell lookup");

    return fromShell;
}
