/**
 * Project resolution utilities for Claude Code's ~/.claude/projects/ directory.
 *
 * Claude encodes cwds by replacing "/" with "-" (e.g. /Users/jane/Projects/Foo → -Users-jane-Projects-Foo).
 * This module provides encoding, decoding, resolution, and caching for these encoded paths.
 */

import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, resolve, sep } from "node:path";
import { getMainRepoRootSync } from "@app/utils/git/worktree";

export const CLAUDE_DIR = resolve(homedir(), ".claude");
export const PROJECTS_DIR = resolve(CLAUDE_DIR, "projects");

/**
 * Encode a cwd path to the ~/.claude/projects/ directory name format.
 * When running inside a git worktree, resolves to the main repo root
 * so sessions are found in the correct directory.
 */
export function encodedProjectDir(cwd?: string): string {
    const p = cwd ?? getMainRepoRootSync(process.cwd());
    return `-${p.replace(/^[/\\]/, "").replaceAll(sep, "-")}`;
}

/**
 * Resolve a project identifier to the full path of its ~/.claude/projects/ directory.
 *
 * Accepts:
 * - No arg: resolves from current cwd via `encodedProjectDir()`
 * - Encoded dir name (starts with "-"): direct lookup
 * - Project leaf name (e.g. "GenesisTools"): suffix match
 *
 * Returns the full resolved path or undefined if not found.
 */
export function resolveProjectDir(project?: string): string | undefined {
    if (!project) {
        const encoded = encodedProjectDir();
        const exact = resolve(PROJECTS_DIR, encoded);
        if (existsSync(exact)) {
            return exact;
        }
        return undefined;
    }

    // Encoded dir name — direct lookup
    if (project.startsWith("-")) {
        const exact = resolve(PROJECTS_DIR, project);
        if (existsSync(exact)) {
            return exact;
        }
    }

    // Fallback: scan for suffix match
    try {
        const dirs = readdirSync(PROJECTS_DIR);
        const match = dirs.find((d) => d === project || d.endsWith(`-${project}`));
        if (match) {
            return resolve(PROJECTS_DIR, match);
        }
    } catch {
        // PROJECTS_DIR doesn't exist
    }

    return undefined;
}

/**
 * Resolve the current working directory to a project filter string
 * that matches ~/.claude/projects/ directory names.
 *
 * Returns the encoded dir name (e.g. "-Users-jane-Projects-acme-corp-web-app")
 * if it exists, or falls back to basename(cwd) for partial glob matching.
 */
export function resolveProjectFilter(cwd?: string): string | undefined {
    const encoded = encodedProjectDir(cwd);
    const exact = resolve(PROJECTS_DIR, encoded);

    if (existsSync(exact)) {
        return encoded;
    }

    return basename(cwd ?? process.cwd()) || undefined;
}

/**
 * Detect the current project name from cwd.
 * Returns the last path segment (directory name), e.g. "GenesisTools".
 */
export function detectCurrentProject(): string | undefined {
    return basename(process.cwd()) || undefined;
}

// ---------------------------------------------------------------------------
// Project name extraction from encoded dirs
// ---------------------------------------------------------------------------

const projectNameCache = new Map<string, string>();

/**
 * Extract the human-readable project name from a file path under PROJECTS_DIR.
 * Uses filesystem walking to resolve ambiguous dashes. Results are cached.
 */
export function extractProjectName(filePath: string): string {
    const projectDir = filePath.replace(`${PROJECTS_DIR}${sep}`, "").split(sep)[0];

    const cached = projectNameCache.get(projectDir);
    if (cached) {
        return cached;
    }

    const name = resolveProjectNameFromEncoded(projectDir);
    projectNameCache.set(projectDir, name);
    return name;
}

/**
 * Resolve a project name from an encoded Claude projects directory name.
 * Claude encodes cwds by replacing "/" with "-", which is ambiguous for
 * directory names containing dashes (e.g. "my-app" → "my" + "app").
 * We resolve by progressively checking the filesystem for each candidate path.
 */
export function resolveProjectNameFromEncoded(projectDir: string): string {
    if (!projectDir.startsWith("-")) {
        return projectDir;
    }

    const home = homedir();
    const homeEncoded = home.replaceAll("/", "-").replaceAll("\\", "-");

    if (!projectDir.startsWith(homeEncoded)) {
        const parts = projectDir.split("-");
        return parts[parts.length - 1] || projectDir;
    }

    const relativeEncoded = projectDir.slice(homeEncoded.length + 1);
    const parts = relativeEncoded.split("-");
    let resolved = home;

    for (let i = 0; i < parts.length; i++) {
        const asDir = resolve(resolved, parts[i]);
        if (existsSync(asDir)) {
            resolved = asDir;
            continue;
        }

        let accumulated = parts[i];
        let found = false;
        for (let j = i + 1; j < parts.length; j++) {
            accumulated += `-${parts[j]}`;
            const tryPath = resolve(resolved, accumulated);
            if (existsSync(tryPath)) {
                resolved = tryPath;
                i = j;
                found = true;
                break;
            }
        }

        if (!found) {
            resolved = resolve(resolved, accumulated);
            break;
        }
    }

    return basename(resolved) || projectDir;
}
