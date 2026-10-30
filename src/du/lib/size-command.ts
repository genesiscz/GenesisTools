import { statSync } from "node:fs";
import { resolve } from "node:path";
import { spawnRunner } from "@genesiscz/utils/git/origins/runner";
import type { CommandRunner } from "@genesiscz/utils/git/origins/types";
import { logger, out } from "@genesiscz/utils/logger";
import { cached, maxCacheAgeOption } from "@genesiscz/utils/storage/cache-flag";
import { Storage } from "@genesiscz/utils/storage/storage";
import type { Command } from "commander";
import { duSize } from "./engine";

const storage = new Storage("du");
/** `du` on a 5-6 GB worktree took up to 17 s on a full, loaded disk (2026-10-27). */
const DU_TIMEOUT_MS = 120_000;

/**
 * The engine's listing walk: the figure `du -sk` prints (allocated blocks, a hard-linked inode once) from one parallel
 * getattrlistbulk pass that opens no file. Null when it cannot answer (a file, no compiler for the dylib, a root that
 * could not be read), and `du` runs instead.
 */
function nativeKb(path: string): number | null {
    try {
        if (!statSync(path).isDirectory()) {
            return null;
        }

        const walked = duSize(path);

        if (walked.dirs === 0) {
            logger.debug({ path, readErrors: walked.readErrors }, "du size: the native walk could not read the root");
            return null;
        }

        logger.debug({ path, files: walked.files, walkMs: walked.walkMs, kib: walked.kib }, "du size: native walk");
        return walked.kib;
    } catch (err) {
        logger.debug({ err, path }, "du size: native walk unavailable, du runs");
        return null;
    }
}

/**
 * What `du -sk <path>` prints (the allocated KiB, clones counted at full size, a hard-linked inode once), from the
 * engine's listing walk, or from `du` itself when the walk cannot answer, served from a cache every caller on this
 * Mac shares when it is at most `maxCacheAgeSeconds` old. Null for a path neither could read; that answer is not
 * stored.
 */
export async function folderKb({
    path,
    maxCacheAgeSeconds,
    run = spawnRunner,
}: {
    path: string;
    maxCacheAgeSeconds?: number;
    run?: CommandRunner;
}): Promise<{ value: number | null; hit: boolean }> {
    const absolutePath = resolve(path);

    return cached<number | null>({
        storage,
        key: `sizes/${Bun.hash(absolutePath).toString(16)}.json`,
        maxAgeSeconds: maxCacheAgeSeconds,
        // Sessions that ask together after an install wait for one walk instead of each walking the folder.
        shareInFlight: `du/${absolutePath}`,
        fetch: async () => {
            const native = nativeKb(absolutePath);

            if (native !== null) {
                return native;
            }

            const done = await run(["du", "-sk", absolutePath], { cwd: "/", timeoutMs: DU_TIMEOUT_MS });
            const token = done.stdout.trim().split("\n").pop()?.split(/\s+/)[0] ?? "";
            const kb = Number(token);

            if (done.code !== 0 || !/^\d+$/.test(token) || !Number.isFinite(kb)) {
                logger.warn({ path, exit: done.code, stderr: done.stderr.slice(-300) }, "du -sk gave no size");
                return null;
            }

            return kb;
        },
        shouldStore: (kb) => kb !== null,
    });
}

/** `tools du size <paths...>`: each path's `du -sk` size in KiB as JSON, cacheable with `--max-cache-age`. */
export function registerSizeCommand(program: Command): void {
    program
        .command("size")
        .description("Plain du -sk size of each path in KiB, as JSON; --max-cache-age shares one answer across callers")
        .argument("<paths...>", "Folders or files")
        .addOption(maxCacheAgeOption("size"))
        .action(async (paths: string[], opts: { maxCacheAge?: number }) => {
            const sizes: Record<string, number | null> = {};

            for (const path of paths) {
                sizes[path] = (await folderKb({ path, maxCacheAgeSeconds: opts.maxCacheAge })).value;
            }

            logger.debug({ sizes }, "du size answered");
            out.result(sizes);
        });
}
