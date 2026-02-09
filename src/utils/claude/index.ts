/**
 * Shared utilities for working with Claude Code data (projects, transcripts).
 * Provides path resolution and JSONL transcript parsing.
 */

import { createReadStream } from "fs";
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
