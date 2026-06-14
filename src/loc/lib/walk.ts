import { type Dirent, existsSync, readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { logger } from "@app/logger";
import { concurrentMap } from "@app/utils/async";
import ignore, { type Ignore } from "ignore";
import type { FileResult } from "./aggregate";
import { classifyFile } from "./classify";
import { resolveLanguage } from "./languages";

export interface ScanInput {
    root: string;
    gitignore: boolean;
    includeHidden: boolean;
}

const ALWAYS_SKIP = new Set([".git", "node_modules"]);

function toPosix(p: string): string {
    return p.split(sep).join("/");
}

function loadGitignore(root: string): Ignore | null {
    const gitignorePath = join(root, ".gitignore");

    try {
        if (existsSync(gitignorePath)) {
            return ignore().add(readFileSync(gitignorePath, "utf-8"));
        }
    } catch (err) {
        logger.warn({ gitignorePath, error: err }, "loc: failed to read .gitignore");
    }

    return null;
}

async function collectFiles(input: ScanInput): Promise<string[]> {
    const { root, gitignore, includeHidden } = input;
    const ig = gitignore ? loadGitignore(root) : null;
    const files: string[] = [];

    async function walk(dir: string): Promise<void> {
        let entries: Dirent[];
        try {
            entries = await readdir(dir, { withFileTypes: true });
        } catch (err) {
            logger.debug({ dir, error: err }, "loc: skipped unreadable directory");
            return;
        }

        for (const entry of entries) {
            const name = entry.name;

            if (ALWAYS_SKIP.has(name)) {
                continue;
            }

            if (!includeHidden && name.startsWith(".")) {
                continue;
            }

            const abs = join(dir, name);
            const rel = toPosix(relative(root, abs));

            if (ig && rel.length > 0) {
                const probe = entry.isDirectory() ? `${rel}/` : rel;
                if (ig.ignores(probe)) {
                    continue;
                }
            }

            if (entry.isDirectory()) {
                await walk(abs);
            } else if (entry.isFile()) {
                files.push(abs);
            }
        }
    }

    await walk(root);
    return files;
}

function extOf(filePath: string): string {
    const base = filePath.split(sep).pop() ?? filePath;
    const dot = base.lastIndexOf(".");
    if (dot <= 0) {
        return "";
    }

    return base.slice(dot + 1).toLowerCase();
}

export async function scanDirectory(input: ScanInput): Promise<FileResult[]> {
    const filePaths = await collectFiles(input);
    logger.debug({ root: input.root, count: filePaths.length }, "loc: collected files");

    const read = await concurrentMap({
        items: filePaths,
        concurrency: 50,
        fn: async (filePath): Promise<FileResult | null> => {
            const ext = extOf(filePath);
            try {
                const content = await Bun.file(filePath).text();
                return { ext, language: resolveLanguage(ext), counts: classifyFile({ content, ext }) };
            } catch (err) {
                logger.debug({ filePath, error: err }, "loc: skipped unreadable file");
                return null;
            }
        },
    });

    const results: FileResult[] = [];
    for (const [, value] of read) {
        if (value) {
            results.push(value);
        }
    }

    return results;
}
