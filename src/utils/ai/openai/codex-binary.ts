import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { logger } from "@genesiscz/utils/logger";

const HOME_DIRS = [".bun/bin", ".local/bin"];
const SYSTEM_DIRS = ["/opt/homebrew/bin", "/usr/local/bin"];

/**
 * Absolute path of the `codex` CLI, or the bare name when nothing is found.
 *
 * The launchd-run usage daemon carries a PATH without /opt/homebrew/bin, where the
 * Homebrew cask installs codex, so every bare `codex` spawn from it failed with
 * "Executable not found in $PATH" (636 polls on 2026-09-10 alone). PATH is read
 * explicitly because Bun.which ignores later mutations of process.env.PATH.
 */
export function resolveCodexBinary(): string {
    const fromPath = Bun.which("codex", { PATH: env.getProcessEnv().PATH ?? "" });
    if (fromPath) {
        return fromPath;
    }

    const home = homedir();
    const candidates = [
        ...HOME_DIRS.map((dir) => join(home, dir, "codex")),
        ...SYSTEM_DIRS.map((dir) => join(dir, "codex")),
    ];
    for (const candidate of candidates) {
        if (existsSync(candidate)) {
            logger.debug({ candidate }, "[codex] resolved via fallback dir (not on PATH)");
            return candidate;
        }
    }

    return "codex";
}
