import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { encodedProjectDir } from "@app/utils/claude";

/** Absolute path to the project-scoped MEMORY.md (creates no directories). */
export function getMemoryPath(cwd?: string): string {
    return join(homedir(), ".claude", "projects", encodedProjectDir(cwd), "memory", "MEMORY.md");
}

export function readMemory(cwd?: string): string | null {
    const path = getMemoryPath(cwd);

    if (!existsSync(path)) {
        return null;
    }

    return readFileSync(path, "utf-8");
}

/**
 * Grep lines of MEMORY.md for a pattern. Case-insensitive substring match
 * when pattern is a string; regex when pattern is a RegExp.
 */
export function grepMemory(pattern: string, cwd?: string): string[] {
    const content = readMemory(cwd);

    if (!content) {
        return [];
    }

    const needle = pattern.toLowerCase();
    return content.split("\n").filter((line) => line.toLowerCase().includes(needle));
}

/** Append a bullet line to MEMORY.md, creating the file (and parent dir) if needed. */
export function appendMemory(entry: string, cwd?: string): string {
    const path = getMemoryPath(cwd);
    const dir = dirname(path);

    if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
    }

    const line = entry.startsWith("- ") ? entry : `- ${entry}`;
    const prefix = existsSync(path) && !readFileSync(path, "utf-8").endsWith("\n") ? "\n" : "";
    appendFileSync(path, `${prefix}${line}\n`);
    return path;
}
