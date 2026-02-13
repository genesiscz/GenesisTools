/**
 * Shared utilities for working with Claude Code data (projects, transcripts).
 * Provides path resolution and JSONL transcript parsing.
 */

import { createReadStream, existsSync } from "fs";
import { homedir } from "os";
import { resolve } from "path";
import { createInterface } from "readline";

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
export async function parseJsonlTranscript<T = Record<string, unknown>>(
    filePath: string,
): Promise<T[]> {
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
    const shell = process.env.SHELL || "/bin/zsh";

    for (const cmd of ["ccc", "cc", "claude"]) {
        const proc = Bun.spawn({
            cmd: [shell, "-ic", `${cmd} --version 2>&1`],
            stdio: ["ignore", "pipe", "pipe"],
        });
        const stdout = await new Response(proc.stdout).text();
        await proc.exited;

        if (proc.exitCode === 0 && stdout.includes("Claude Code")) {
            return cmd;
        }
    }
    return "claude";
}

/**
 * Detect the current project name from cwd.
 * Returns the last path segment (directory name), e.g. "GenesisTools".
 */
export function detectCurrentProject(): string | undefined {
    return process.cwd().split("/").pop();
}

/**
 * Get the encoded project directory name for a cwd path.
 * Claude encodes /Users/Martin/Projects/Foo as -Users-Martin-Projects-Foo.
 */
export function encodedProjectDir(cwd?: string): string {
    return (cwd ?? process.cwd()).replaceAll("/", "-");
}
