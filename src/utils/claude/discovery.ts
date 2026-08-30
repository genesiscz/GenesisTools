/**
 * Session file discovery for Claude Code's ~/.claude/projects/ directory.
 *
 * Shared discovery layer used by both the history search (search.ts)
 * and the sessions tab (session.ts). Only discovers file paths —
 * does not parse metadata or manage caches.
 */

import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { logger } from "@genesiscz/utils/logger";
import { profiler } from "@genesiscz/utils/profile";
import { glob } from "glob";
import { PROJECTS_DIR, resolveProjectFilter } from "./projects";
import { isSubagentFile } from "./session.utils";

export interface DiscoveryOptions {
    /** Project filter: encoded dir name (starts with "-"), project name, or undefined (=current). */
    project?: string;
    /** Search all project dirs. Overrides project. */
    allProjects?: boolean;
    /** Exclude subagent session files (agent-* and subagents/). */
    excludeSubagents?: boolean;
    /** Include subagent files alongside main sessions. */
    includeSubagents?: boolean;
    /** Only return subagent files. */
    subagentsOnly?: boolean;
}

/**
 * Discover JSONL session files under ~/.claude/projects/ matching the given criteria.
 * Uses glob for flexible matching. For known project dirs, prefer `discoverSessionFilesInDir`.
 */
export async function discoverSessionFiles(options: DiscoveryOptions = {}): Promise<string[]> {
    return profiler
        .scope("claude-history")
        .measureAsync("discoverSessionFiles", () => discoverSessionFilesUnprofiled(options));
}

async function discoverSessionFilesUnprofiled(options: DiscoveryOptions = {}): Promise<string[]> {
    const { allProjects = false, subagentsOnly = false } = options;
    const patterns: string[] = [];

    // Resolve project filter
    const project = allProjects ? undefined : (options.project ?? resolveProjectFilter());
    const isEncodedDir = project?.startsWith("-");

    // Fast path for the common "main sessions only" listing. A main session
    // only ever lives as a DIRECT child of its project dir — subagent files
    // sit under <session-id>/subagents/ or carry an agent- prefix — so a
    // one-level readdir replaces the recursive glob, which enumerated ~11k
    // subagent transcripts only to filter them all out (104ms → ~6ms on a
    // 228-project tree). Parity with the glob walk is pinned in
    // discovery.test.ts.
    if (options.excludeSubagents && !subagentsOnly) {
        return discoverMainSessionFiles(project, isEncodedDir === true);
    }

    if (subagentsOnly) {
        if (project && !allProjects) {
            if (isEncodedDir) {
                patterns.push(`${PROJECTS_DIR}/${project}/subagents/*.jsonl`);
                patterns.push(`${PROJECTS_DIR}/${project}/agent-*.jsonl`);
                patterns.push(`${PROJECTS_DIR}/${project}-*/subagents/*.jsonl`);
                patterns.push(`${PROJECTS_DIR}/${project}-*/agent-*.jsonl`);
            } else {
                patterns.push(`${PROJECTS_DIR}/*${project}*/subagents/*.jsonl`);
                patterns.push(`${PROJECTS_DIR}/*${project}*/agent-*.jsonl`);
            }
        } else {
            patterns.push(`${PROJECTS_DIR}/**/subagents/*.jsonl`);
            patterns.push(`${PROJECTS_DIR}/**/agent-*.jsonl`);
        }
    } else if (project && !allProjects) {
        if (isEncodedDir) {
            patterns.push(`${PROJECTS_DIR}/${project}/**/*.jsonl`);
            patterns.push(`${PROJECTS_DIR}/${project}-*/**/*.jsonl`);
        } else {
            patterns.push(`${PROJECTS_DIR}/*${project}*/**/*.jsonl`);
        }
    } else {
        patterns.push(`${PROJECTS_DIR}/**/*.jsonl`);
    }

    let files: string[] = [];
    for (const pattern of patterns) {
        const matched = await glob(pattern, { absolute: true, windowsPathsNoEscape: true });
        files.push(...matched);
    }

    files = [...new Set(files)];

    // Apply subagent filtering
    if (options.excludeSubagents) {
        files = files.filter((f) => !isSubagentFile(f));
    }

    return files;
}

function discoverMainSessionFiles(project: string | undefined, isEncodedDir: boolean): string[] {
    let projectDirs: string[];
    try {
        projectDirs = readdirSync(PROJECTS_DIR, { withFileTypes: true })
            .filter((e) => e.isDirectory())
            .map((e) => e.name)
            .filter((name) => {
                if (project === undefined) {
                    return true;
                }

                // Mirrors the glob patterns: exact + `<encoded>-*` worktree
                // variants for encoded dirs, `*<name>*` substring otherwise.
                if (isEncodedDir) {
                    return name === project || name.startsWith(`${project}-`);
                }

                return name.includes(project);
            });
    } catch (err) {
        logger.debug({ err, dir: PROJECTS_DIR }, "discoverMainSessionFiles: projects dir unreadable");
        return [];
    }

    const files: string[] = [];
    for (const dirName of projectDirs) {
        const projectDir = join(PROJECTS_DIR, dirName);
        try {
            for (const e of readdirSync(projectDir, { withFileTypes: true })) {
                if (e.isFile() && e.name.endsWith(".jsonl") && !e.name.startsWith("agent-")) {
                    files.push(join(projectDir, e.name));
                }
            }
        } catch (err) {
            logger.debug({ err, projectDir }, "discoverMainSessionFiles: project dir unreadable");
        }
    }

    return files;
}

/**
 * Discover JSONL files in a specific project directory using readdir (no glob).
 * Faster than `discoverSessionFiles` when the exact directory is known.
 */
export function discoverSessionFilesInDir(projectDir: string, options: { excludeSubagents?: boolean } = {}): string[] {
    try {
        const entries = readdirSync(projectDir);
        let files = entries.filter((e) => e.endsWith(".jsonl")).map((e) => resolve(projectDir, e));

        // Also scan subagents/ subdirectory
        if (!options.excludeSubagents) {
            const subagentsDir = resolve(projectDir, "subagents");
            try {
                const subEntries = readdirSync(subagentsDir);
                const subFiles = subEntries.filter((e) => e.endsWith(".jsonl")).map((e) => resolve(subagentsDir, e));
                files = files.concat(subFiles);
            } catch {
                // subagents/ doesn't exist — skip
            }
        }

        if (options.excludeSubagents) {
            files = files.filter((f) => !isSubagentFile(f));
        }

        return files;
    } catch {
        return [];
    }
}
