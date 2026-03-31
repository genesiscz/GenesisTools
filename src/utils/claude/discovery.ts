/**
 * Session file discovery for Claude Code's ~/.claude/projects/ directory.
 *
 * Shared discovery layer used by both the history search (search.ts)
 * and the sessions tab (session.ts). Only discovers file paths —
 * does not parse metadata or manage caches.
 */

import { readdirSync } from "node:fs";
import { resolve } from "node:path";
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
    const { allProjects = false, subagentsOnly = false } = options;
    const patterns: string[] = [];

    // Resolve project filter
    const project = allProjects ? undefined : (options.project ?? resolveProjectFilter());
    const isEncodedDir = project?.startsWith("-");

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
