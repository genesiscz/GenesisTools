/**
 * Shared utilities for working with Claude Code data (projects, transcripts).
 * Provides path resolution, JSONL transcript parsing, and shared types.
 */

export { cleanPromptText, cleanTranscriptText } from "../ai/transcripts/clean-text";
export * from "./auth";
export * from "./executable";
export * from "./projects";
export { humanTextOf } from "./session.utils";
export { extractToolInputSummary, extractToolResultText, isAssistantEndTurn } from "./session-helpers";
export * from "./types";

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { readLines } from "@genesiscz/utils/fs/read-lines";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { toolDataDir } from "@genesiscz/utils/storage/root";

export interface ParseJsonlTranscriptOptions {
    /**
     * Skip lines whose `uuid` was already seen (first occurrence wins).
     * Session files can carry duplicated message lines around compaction/resume
     * (measured 2026-07-24: 18 of 324 fable-corpus files, worst 538 dup lines
     * in one session), which silently inflates message counts downstream.
     */
    dedupeUuids?: boolean;
}

/**
 * Parse a JSONL transcript file into an array of message objects.
 * Skips invalid JSON lines silently.
 */
export async function parseJsonlTranscript<T = Record<string, unknown>>(
    filePath: string,
    options: ParseJsonlTranscriptOptions = {}
): Promise<T[]> {
    if (!existsSync(filePath)) {
        return [];
    }

    const messages: T[] = [];
    const seenUuids = options.dedupeUuids ? new Set<string>() : undefined;

    // Cut at "\n" only: readline also ends a line at U+2028 and U+2029, which JSON strings carry raw.
    for await (const line of readLines(filePath)) {
        if (line.trim()) {
            try {
                // Native parsing: a transcript line is strict JSON. The comment-json default spent
                // 2.6 s and 2.5 GB on a 172 MB session where native JSON.parse needs 160 ms.
                const parsed = SafeJSON.parse(line, { jsonl: true }) as T;

                if (seenUuids) {
                    const uuid = (parsed as { uuid?: unknown }).uuid;
                    if (typeof uuid === "string" && uuid) {
                        if (seenUuids.has(uuid)) {
                            continue;
                        }

                        seenUuids.add(uuid);
                    }
                }

                messages.push(parsed);
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
    /** Absent in files written before 2026-11-16, which could hold a pick made while a wrapper did not answer. */
    version?: number;
    command: string;
    shell: string;
    rcPath: string | null;
    rcMtimeMs: number | null;
    cachedAt: number;
}

const RESOLVED_COMMAND_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const RESOLVED_COMMAND_CACHE_VERSION = 2;

function resolvedCommandCachePath(): string {
    return toolDataDir("claude", "resolved-command.json");
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

        if (cache.version !== RESOLVED_COMMAND_CACHE_VERSION || cache.shell !== shell) {
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
            version: RESOLVED_COMMAND_CACHE_VERSION,
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

/**
 * What one probe proved about a candidate. `no-answer` is a name the shell defines whose `--version` failed or ran
 * out of time. It can be the user's wrapper at a bad moment (a Claude Code update in progress, a new binary that
 * macOS still checks), so a pick behind it is good for one launch only.
 */
export type ClaudeCandidateVerdict = "is-claude" | "not-claude" | "no-answer";

/** The probe script's exit code for a name the shell does not define. */
const NOT_DEFINED_EXIT = 97;

/**
 * `command -v` answers for a function and for a file. An alias counts as not defined, because the launch is
 * `exec <command>` and a shell does not expand an alias there.
 */
function probeScript(candidate: string): string {
    const defined = `case "$(command -v '${candidate}' 2>/dev/null)" in ''|alias\\ *) exit ${NOT_DEFINED_EXIT};; esac`;
    return `${defined}; '${candidate}' --version 2>&1`;
}

async function probeClaudeCandidate(input: {
    candidate: string;
    shell: string;
    timeoutMs: number;
}): Promise<ClaudeCandidateVerdict> {
    const proc = findClaudeCommandTestHooks?.spawnProbe
        ? findClaudeCommandTestHooks.spawnProbe(input.candidate, input.shell)
        : Bun.spawn({
              cmd: [input.shell, "-ic", probeScript(input.candidate)],
              stdio: ["ignore", "pipe", "pipe"],
          });

    try {
        const stdout = await Promise.race([
            new Response(proc.stdout).text(),
            new Promise<string>((_, reject) => setTimeout(() => reject(new Error("timeout")), input.timeoutMs)),
        ]);
        await proc.exited;

        if (proc.exitCode === NOT_DEFINED_EXIT) {
            return "not-claude";
        }

        if (proc.exitCode !== 0) {
            return "no-answer";
        }

        return stdout.includes("Claude Code") ? "is-claude" : "not-claude";
    } catch {
        // Timeout or spawn failure
        return "no-answer";
    } finally {
        proc.kill();
    }
}

/**
 * The first candidate that is Claude, or null when none is. `settled` is false while an earlier candidate still gives
 * no answer: the caller must not remember that pick. On 2026-11-15 a probe that ran during a Claude Code update got
 * no answer from the `ccc` wrapper, and the cached `claude` then started every session without the wrapper's flags.
 * @internal exported for tests
 */
export async function pickClaudeCommand(input: {
    candidates: string[];
    probe: (candidate: string) => Promise<ClaudeCandidateVerdict>;
}): Promise<{ command: string; settled: boolean } | null> {
    const silent: string[] = [];

    for (const candidate of input.candidates) {
        const verdict = await input.probe(candidate);

        if (verdict === "no-answer") {
            silent.push(candidate);
            continue;
        }

        if (verdict === "not-claude") {
            continue;
        }

        // This candidate answered, so the binary runs now. Ask the silent ones once more, in their order.
        let settled = true;

        for (const earlier of silent) {
            const second = await input.probe(earlier);

            if (second === "is-claude") {
                return { command: earlier, settled };
            }

            if (second === "no-answer") {
                settled = false;
            }
        }

        return { command: candidate, settled };
    }

    return null;
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

    const picked = await pickClaudeCommand({
        candidates,
        probe: (candidate) => probeClaudeCandidate({ candidate, shell, timeoutMs }),
    });

    if (!picked) {
        return "claude";
    }

    if (!picked.settled) {
        logger.warn(
            { command: picked.command, candidates, shell },
            "[findClaudeCommand] an earlier candidate gave no answer, so this pick is not cached"
        );
    } else if (!findClaudeCommandTestHooks) {
        writeResolvedCommandCache(picked.command, shell);
    }

    return picked.command;
}
