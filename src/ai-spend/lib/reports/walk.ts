import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { logger } from "@genesiscz/utils/logger";

export interface WalkOptions {
    maxDepth: number;
    isFile: (name: string, full: string) => boolean;
    /** Skip files last written before this instant. Usage logs are append-only, so an older file holds nothing newer. */
    minMtimeMs?: number;
}

function writtenSince(file: string, minMtimeMs: number | undefined): boolean {
    if (minMtimeMs === undefined || minMtimeMs <= 0) {
        return true;
    }

    try {
        return statSync(file).mtimeMs >= minMtimeMs;
    } catch (err) {
        logger.debug({ err, file }, "ai-spend: stat failed, file skipped");
        return false;
    }
}

export function walkFiles(roots: string[], options: WalkOptions): string[] {
    const out: string[] = [];

    const walk = (dir: string, depth: number): void => {
        let entries: import("node:fs").Dirent[];

        try {
            entries = readdirSync(dir, { withFileTypes: true });
        } catch (err) {
            logger.debug({ err, dir }, "ai-spend: unreadable dir skipped");
            return;
        }

        for (const entry of entries) {
            const full = join(dir, entry.name);

            if (entry.isDirectory()) {
                if (depth < options.maxDepth) {
                    walk(full, depth + 1);
                }

                continue;
            }

            if (!entry.isFile() || !options.isFile(entry.name, full) || !writtenSince(full, options.minMtimeMs)) {
                continue;
            }

            out.push(full);
        }
    };

    for (const root of roots) {
        if (existsSync(root)) {
            try {
                if (statSync(root).isFile()) {
                    if (options.isFile(root.split("/").pop() ?? root, root) && writtenSince(root, options.minMtimeMs)) {
                        out.push(root);
                    }

                    continue;
                }
            } catch (err) {
                logger.debug({ err, root }, "ai-spend: stat failed");
                continue;
            }

            walk(root, 0);
        }
    }

    out.sort();
    return out;
}

export function readText(file: string): string | null {
    try {
        return readFileSync(file, "utf8");
    } catch (err) {
        logger.debug({ err, file }, "ai-spend: failed to read usage file");
        return null;
    }
}

export function readBytes(file: string): Buffer | null {
    try {
        return readFileSync(file);
    } catch (err) {
        logger.debug({ err, file }, "ai-spend: failed to read usage file");
        return null;
    }
}

export function envPathList(raw: string | undefined): string[] {
    if (!raw) {
        return [];
    }

    return raw
        .split(",")
        .map((path) => path.trim())
        .filter((path) => path.length > 0);
}
