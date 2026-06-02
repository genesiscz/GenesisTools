import { type Dirent, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { logger } from "@app/logger";
import ignore, { type Ignore } from "ignore";

const ALWAYS_SKIP_DIRS = new Set([".git", "node_modules"]);

export interface WalkedFile {
    absPath: string;
    relPath: string;
}

interface WalkArgs {
    dir: string;
    respectGitignore: boolean;
    maxSizeKb: number;
}

function loadGitignore(dir: string): Ignore | null {
    const gitignorePath = join(dir, ".gitignore");

    if (!existsSync(gitignorePath)) {
        return null;
    }

    try {
        return ignore().add(readFileSync(gitignorePath, "utf-8"));
    } catch (err) {
        logger.warn({ err, gitignorePath }, "scan-secrets: failed to read .gitignore");
        return null;
    }
}

function toPosixRel(root: string, abs: string): string {
    return relative(root, abs).split(sep).join("/");
}

/**
 * Walk `dir` returning text-file candidates. Always skips `.git` and
 * `node_modules`; optionally honors `.gitignore`. Size filtering happens here;
 * binary detection happens at read time in scan-dir.
 */
export function walkFiles({ dir, respectGitignore, maxSizeKb }: WalkArgs): WalkedFile[] {
    const gitignore = respectGitignore ? loadGitignore(dir) : null;
    const maxBytes = maxSizeKb * 1024;
    const out: WalkedFile[] = [];

    const walk = (current: string): void => {
        let entries: Dirent[];

        try {
            entries = readdirSync(current, { withFileTypes: true });
        } catch (err) {
            logger.debug({ err, current }, "scan-secrets: readdir failed");
            return;
        }

        for (const entry of entries) {
            const abs = join(current, entry.name);
            const rel = toPosixRel(dir, abs);

            if (entry.isDirectory()) {
                if (ALWAYS_SKIP_DIRS.has(entry.name)) {
                    continue;
                }

                if (gitignore?.ignores(`${rel}/`)) {
                    continue;
                }

                walk(abs);
                continue;
            }

            if (!entry.isFile()) {
                continue;
            }

            if (gitignore?.ignores(rel)) {
                continue;
            }

            try {
                if (statSync(abs).size > maxBytes) {
                    logger.debug({ rel }, "scan-secrets: skip (too large)");
                    continue;
                }
            } catch (err) {
                logger.debug({ err, rel }, "scan-secrets: stat failed");
                continue;
            }

            out.push({ absPath: abs, relPath: rel });
        }
    };

    walk(dir);
    return out;
}
