/**
 * Azure DevOps CLI - Task file path utilities
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { FoundTaskFile } from "@app/azure-devops/types";
import { slugify } from "@app/utils/string";

/**
 * Get the tasks directory (always in cwd), optionally with category subdirectory
 */
export function getTasksDir(category?: string): string {
    const base = join(process.cwd(), ".claude/azure/tasks");
    return category ? join(base, category) : base;
}

/**
 * Find task file in a specific directory (flat, not in task subfolder)
 */
export function findTaskFileFlat(id: number, ext: string, dir: string): string | null {
    if (!existsSync(dir)) {
        return null;
    }

    const files = readdirSync(dir);
    const match = files.find((f) => f.startsWith(`${id}-`) && f.endsWith(`.${ext}`));
    return match ? join(dir, match) : null;
}

/**
 * Find task file in task subfolder (<dir>/<id>/<id>-...)
 */
export function findTaskFileInFolder(id: number, ext: string, dir: string): string | null {
    const taskFolderPath = join(dir, String(id));

    if (!existsSync(taskFolderPath)) {
        return null;
    }

    const files = readdirSync(taskFolderPath);
    const match = files.find((f) => f.startsWith(`${id}-`) && f.endsWith(`.${ext}`));
    return match ? join(taskFolderPath, match) : null;
}

/**
 * Find task file - checks both flat and folder structure
 */
export function findTaskFile(id: number, ext: string, category?: string): string | null {
    const tasksDir = getTasksDir(category);
    // Check flat first, then folder
    return findTaskFileFlat(id, ext, tasksDir) || findTaskFileInFolder(id, ext, tasksDir);
}

/**
 * Search for task file in any location (root, categories, with/without task folders)
 */
export function findTaskFileAnywhere(id: number, ext: string): FoundTaskFile | null {
    const baseTasksDir = getTasksDir();

    if (!existsSync(baseTasksDir)) {
        return null;
    }

    // Check root flat
    const rootFlat = findTaskFileFlat(id, ext, baseTasksDir);

    if (rootFlat) {
        return { path: rootFlat, inTaskFolder: false };
    }

    // Check root task folder
    const rootFolder = findTaskFileInFolder(id, ext, baseTasksDir);

    if (rootFolder) {
        return { path: rootFolder, inTaskFolder: true };
    }

    // Check category subdirectories
    const entries = readdirSync(baseTasksDir, { withFileTypes: true });

    for (const entry of entries) {
        if (entry.isDirectory() && entry.name !== String(id)) {
            const categoryDir = join(baseTasksDir, entry.name);

            // Check flat in category
            const catFlat = findTaskFileFlat(id, ext, categoryDir);

            if (catFlat) {
                return { path: catFlat, category: entry.name, inTaskFolder: false };
            }

            // Check task folder in category
            const catFolder = findTaskFileInFolder(id, ext, categoryDir);

            if (catFolder) {
                return { path: catFolder, category: entry.name, inTaskFolder: true };
            }
        }
    }

    return null;
}

export function getTaskFilePath(
    id: number,
    title: string,
    ext: string,
    category?: string,
    useTaskFolder?: boolean
): string {
    const slug = slugify(title);
    const base = getTasksDir(category);

    if (useTaskFolder) {
        return join(base, String(id), `${id}-${slug}.${ext}`);
    }

    return join(base, `${id}-${slug}.${ext}`);
}
