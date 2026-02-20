/**
 * Shared utilities for working with Claude Code data (projects, transcripts).
 * Provides path resolution, JSONL transcript parsing, and shared types.
 */

export * from "./auth";
// Re-export shared types
export * from "./types";

import { createReadStream, existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, resolve, sep } from "node:path";
import { createInterface } from "node:readline";

export const CLAUDE_DIR = resolve(homedir(), ".claude");
export const PROJECTS_DIR = resolve(CLAUDE_DIR, "projects");

/**
 * Get the Claude projects directory path.
 */
export function getClaudeProjectsDir(): string {
    return PROJECTS_DIR;
}

/**
 * Parse a JSONL transcript file into an array of message objects.
 * Skips invalid JSON lines silently.
 */
export async function parseJsonlTranscript<T = Record<string, unknown>>(filePath: string): Promise<T[]> {
    if (!existsSync(filePath)) return [];

    const messages: T[] = [];

    const fileStream = createReadStream(filePath);
    const rl = createInterface({
        input: fileStream,
        crlfDelay: Number.POSITIVE_INFINITY,
    });

    for await (const line of rl) {
        if (line.trim()) {
            try {
                messages.push(JSON.parse(line) as T);
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
export async function findClaudeCommand(): Promise<string> {
    const shell = process.env.SHELL || "/bin/sh";

    for (const candidate of ["ccc", "cc", "claude"]) {
        try {
            const proc = Bun.spawn({
                cmd: [shell, "-ic", `'${candidate}' --version 2>&1`],
                stdio: ["ignore", "pipe", "pipe"],
            });
            const stdout = await Promise.race([
                new Response(proc.stdout).text(),
                new Promise<string>((_, reject) => setTimeout(() => reject(new Error("timeout")), 3000)),
            ]);
            await proc.exited;

            if (proc.exitCode === 0 && stdout.includes("Claude Code")) {
                return candidate;
            }
        } catch {
            // Timeout or spawn failure — skip this candidate
        }
    }
    return "claude";
}

/**
 * Detect the current project name from cwd.
 * Returns the last path segment (directory name), e.g. "GenesisTools".
 */
export function detectCurrentProject(): string | undefined {
    return basename(process.cwd()) || undefined;
}

/**
 * Get the encoded project directory name for a cwd path.
 * Claude encodes /Users/jane/Projects/Foo as -Users-jane-Projects-Foo.
 */
export function encodedProjectDir(cwd?: string): string {
    const p = cwd ?? process.cwd();
    // Prepend a dash to match the observed encoding format.
    return `-${p.replace(/^\//, "").replaceAll(sep, "-")}`;
}
