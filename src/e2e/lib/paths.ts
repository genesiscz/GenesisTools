import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { toolDataDir } from "@genesiscz/utils/storage/root";

/** A file-safe local time stamp for a run folder: `2026-11-04T21-05-33`. */
export function stamp(date = new Date()): string {
    const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
    return local.toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

/** `~/.genesis-tools/e2e/runs/<project>`: every run of one project. */
export function runsRoot(projectId: string): string {
    return toolDataDir("e2e", "runs", projectId);
}

export function newRunDir(projectId: string, date = new Date()): string {
    return join(runsRoot(projectId), stamp(date));
}

/** The project's run folders, newest first. */
export function listRunDirs(projectId: string): string[] {
    const root = runsRoot(projectId);

    if (!existsSync(root)) {
        return [];
    }

    return readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort()
        .reverse()
        .map((name) => join(root, name));
}
