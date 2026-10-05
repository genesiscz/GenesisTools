import { readdirSync, realpathSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { logger } from "@genesiscz/utils/logger";

export interface FileMetadata {
    path: string;
    absolutePath: string;
    size: number;
    mtime: Date;
    relativePath: string;
}

/**
 * Every file under `root` after an install, symlinks followed the way a package manager lays them
 * out (pnpm links node_modules/<pkg> into .pnpm), with a guard so a link back up the tree is not
 * walked forever. Read after the install has finished, so a fast or cached install loses nothing.
 */
export function collectInstalledFiles(root: string): FileMetadata[] {
    const files: FileMetadata[] = [];

    const walk = (dir: string, ancestors: Set<string>): void => {
        let real: string;

        try {
            real = realpathSync(dir);
        } catch (error) {
            logger.debug({ error, dir }, "npm-package-diff: a folder could not be resolved");
            return;
        }

        if (ancestors.has(real)) {
            return;
        }

        const chain = new Set(ancestors).add(real);

        for (const entry of readdirSync(dir)) {
            const path = join(dir, entry);
            let stats: ReturnType<typeof statSync>;

            try {
                stats = statSync(path);
            } catch (error) {
                logger.debug({ error, path }, "npm-package-diff: a broken link is skipped");
                continue;
            }

            if (stats.isDirectory()) {
                walk(path, chain);
            } else if (stats.isFile()) {
                files.push({
                    path,
                    absolutePath: path,
                    size: stats.size,
                    mtime: stats.mtime,
                    relativePath: relative(root, path),
                });
            }
        }
    };

    walk(root, new Set());
    return files;
}
