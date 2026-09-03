import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { logger } from "@genesiscz/utils/logger";

export interface WalkOptions {
    maxDepth: number;
    isFile: (name: string, full: string) => boolean;
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

            if (!entry.isFile() || !options.isFile(entry.name, full)) {
                continue;
            }

            out.push(full);
        }
    };

    for (const root of roots) {
        if (existsSync(root)) {
            try {
                if (statSync(root).isFile()) {
                    if (options.isFile(root.split("/").pop() ?? root, root)) {
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

export function envPathList(raw: string | undefined): string[] {
    if (!raw) {
        return [];
    }

    return raw
        .split(",")
        .map((path) => path.trim())
        .filter((path) => path.length > 0);
}
