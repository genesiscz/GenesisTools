/**
 * Shared utilities for working with Claude Code data (projects, transcripts).
 * Provides path resolution, JSONL transcript parsing, and shared types.
 */

export * from "./auth";
export * from "./projects";
export { extractToolInputSummary, extractToolResultText, isAssistantEndTurn } from "./session-helpers";
export * from "./types";

import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";

/**
 * Parse a JSONL transcript file into an array of message objects.
 * Skips invalid JSON lines silently.
 */
export async function parseJsonlTranscript<T = Record<string, unknown>>(filePath: string): Promise<T[]> {
    if (!existsSync(filePath)) {
        return [];
    }

    const messages: T[] = [];

    const fileStream = createReadStream(filePath);
    const rl = createInterface({
        input: fileStream,
        crlfDelay: Number.POSITIVE_INFINITY,
    });

    for await (const line of rl) {
        if (line.trim()) {
            try {
                messages.push(SafeJSON.parse(line) as T);
            } catch {
                // Skip invalid JSON lines
            }
        }
    }

    return messages;
}

/**
 * Find the claude CLI command name available on this system.
 * Checks for `ccc`, `cc` (aliases/functions) first, then falls back to `claude`.
 * Uses interactive shell to resolve functions/aliases from ~/.zshrc,
 * and verifies the command is actually Claude (not e.g. the C compiler for `cc`).
 */
export interface FindClaudeCommandTestHooks {
    candidates?: string[];
    timeoutMs?: number;
    spawnProbe?: (candidate: string, shell: string) => ReturnType<typeof Bun.spawn>;
}

let findClaudeCommandTestHooks: FindClaudeCommandTestHooks | undefined;

/** @internal test-only hook */
export function _setFindClaudeCommandTestHooks(hooks: FindClaudeCommandTestHooks | undefined): void {
    findClaudeCommandTestHooks = hooks;
}

/**
 * Resolving the command probes an interactive shell (~350-480ms) to pick up the
 * user's `ccc`/`cc`/`claude` wrapper functions from their rc file. The winner
 * changes only when they edit that rc file, so cache it keyed on shell + rc mtime
 * — editing the wrapper invalidates it, and a 7-day TTL is a belt-and-suspenders
 * fallback. Every `tools claude start/run` launch would otherwise pay the probe.
 */
interface ResolvedCommandCache {
    command: string;
    shell: string;
    rcPath: string | null;
    rcMtimeMs: number | null;
    cachedAt: number;
}

const RESOLVED_COMMAND_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function resolvedCommandCachePath(): string {
    return join(env.paths.getHome(), ".genesis-tools", "claude", "resolved-command.json");
}

/** The interactive rc file that defines the wrapper functions, for cache invalidation. */
function interactiveRcPath(shell: string): string | null {
    const base = shell.split("/").pop() ?? "";
    const home = env.paths.getHome();
    if (base.includes("zsh")) {
        return join(home, ".zshrc");
    }

    if (base.includes("bash")) {
        return join(home, ".bashrc");
    }

    return null;
}

function rcMtimeMs(rcPath: string | null): number | null {
    if (!rcPath) {
        return null;
    }

    try {
        return statSync(rcPath).mtimeMs;
    } catch {
        return null;
    }
}

function readResolvedCommandCache(shell: string): string | null {
    try {
        const path = resolvedCommandCachePath();
        if (!existsSync(path)) {
            return null;
        }

        const cache = SafeJSON.parse(readFileSync(path, "utf8")) as ResolvedCommandCache;

        if (cache.shell !== shell) {
            return null;
        }

        if (Date.now() - cache.cachedAt > RESOLVED_COMMAND_CACHE_TTL_MS) {
            return null;
        }

        const currentMtime = rcMtimeMs(interactiveRcPath(shell));
        if (currentMtime !== cache.rcMtimeMs) {
            return null;
        }

        logger.debug({ command: cache.command, shell }, "[findClaudeCommand] cache hit");
        return cache.command;
    } catch (error) {
        logger.debug({ error }, "[findClaudeCommand] cache read failed");
        return null;
    }
}

function writeResolvedCommandCache(command: string, shell: string): void {
    try {
        const path = resolvedCommandCachePath();
        mkdirSync(dirname(path), { recursive: true });
        const rcPath = interactiveRcPath(shell);
        const cache: ResolvedCommandCache = {
            command,
            shell,
            rcPath,
            rcMtimeMs: rcMtimeMs(rcPath),
            cachedAt: Date.now(),
        };
        writeFileSync(path, SafeJSON.stringify(cache, null, 2));
        logger.debug({ command, shell }, "[findClaudeCommand] cached resolved command");
    } catch (error) {
        logger.debug({ error }, "[findClaudeCommand] cache write failed");
    }
}

export async function findClaudeCommand(): Promise<string> {
    const shell = env.paths.getShell("/bin/sh");
    const candidates = findClaudeCommandTestHooks?.candidates ?? ["ccc", "cc", "claude"];
    const timeoutMs = findClaudeCommandTestHooks?.timeoutMs ?? 3000;

    // Test hooks force a live probe; production reads the mtime-keyed cache first.
    if (!findClaudeCommandTestHooks) {
        const cached = readResolvedCommandCache(shell);
        if (cached) {
            return cached;
        }
    }

    for (const candidate of candidates) {
        const proc = findClaudeCommandTestHooks?.spawnProbe
            ? findClaudeCommandTestHooks.spawnProbe(candidate, shell)
            : Bun.spawn({
                  cmd: [shell, "-ic", `'${candidate}' --version 2>&1`],
                  stdio: ["ignore", "pipe", "pipe"],
              });

        try {
            const stdout = await Promise.race([
                new Response(proc.stdout).text(),
                new Promise<string>((_, reject) => setTimeout(() => reject(new Error("timeout")), timeoutMs)),
            ]);
            await proc.exited;

            if (proc.exitCode === 0 && stdout.includes("Claude Code")) {
                if (!findClaudeCommandTestHooks) {
                    writeResolvedCommandCache(candidate, shell);
                }

                return candidate;
            }
        } catch {
            // Timeout or spawn failure — skip this candidate
        } finally {
            proc.kill();
        }
    }
    return "claude";
}
