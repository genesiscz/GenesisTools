import { statSync } from "node:fs";
import { resolve } from "node:path";
import { spawnRunner } from "@genesiscz/utils/git/origins/runner";
import type { CommandRunner } from "@genesiscz/utils/git/origins/types";
import { logger, out } from "@genesiscz/utils/logger";
import { cached, maxCacheAgeOption } from "@genesiscz/utils/storage/cache-flag";
import { Storage } from "@genesiscz/utils/storage/storage";
import type { Command } from "commander";
import { type DuSizeResult, ensureBinary, parseDuSize } from "./engine";

const storage = new Storage("du");
/** `du` on a 5-6 GB worktree took up to 17 s on a full, loaded disk (2026-10-27). */
const DU_TIMEOUT_MS = 120_000;

/**
 * The engine's listing walk, `clonesize --dusize <path>`: the figure `du -sk` prints (allocated blocks, a hard-linked
 * inode once) from one parallel getattrlistbulk pass that opens no file. It runs as a child under the same deadline
 * as `du`, because open() on a protected folder can wait for the user's answer to a privacy prompt, and only a
 * process can be killed out of that wait. Null when it cannot answer (a file, no compiler for the binary, a walk
 * past the deadline, a root that could not be read, a folder it could not list or was denied, a cloud folder or a
 * mounted volume it did not enter), and `du` runs instead.
 */
export async function nativeDuSize(
    path: string,
    { run = spawnRunner, binary = ensureBinary }: { run?: CommandRunner; binary?: () => string } = {}
): Promise<DuSizeResult | null> {
    let argv: string[];

    try {
        if (!statSync(path).isDirectory()) {
            return null;
        }

        argv = [binary(), "--dusize", path];
    } catch (err) {
        logger.debug({ err, path }, "du size: native walk unavailable, du runs");
        return null;
    }

    const done = await run(argv, { cwd: "/", timeoutMs: DU_TIMEOUT_MS });

    if (done.code !== 0) {
        logger.debug(
            { path, exit: done.code, stderr: done.stderr.slice(-300) },
            "du size: the native walk failed or passed its deadline, du runs"
        );
        return null;
    }

    let walked: DuSizeResult;

    try {
        walked = parseDuSize(done.stdout);
    } catch (err) {
        logger.debug({ err, path }, "du size: the native walk's reply is not JSON, du runs");
        return null;
    }

    if (walked.dirs === 0) {
        logger.debug({ path, readErrors: walked.readErrors }, "du size: the native walk could not read the root");
        return null;
    }

    // `dirs` counts the folders the walk opened, not a finished walk: a listing that failed part way or a denied
    // folder below the root leaves a total that is too small, and a cached answer would serve it for the cache's age.
    if (walked.readErrors > 0 || walked.deniedDirs > 0) {
        logger.debug(
            { path, readErrors: walked.readErrors, deniedDirs: walked.deniedDirs, kib: walked.kib },
            "du size: the native walk is incomplete, du runs"
        );
        return null;
    }

    // The walk does not enter a cloud-provider root or a dataless folder (reading one can block in the provider or
    // download), while du counts what is on disk there: its total is the honest one for such a root.
    if (walked.skippedCloud > 0) {
        logger.debug(
            { path, skippedCloud: walked.skippedCloud, kib: walked.kib },
            "du size: the native walk left out cloud folders, du runs"
        );
        return null;
    }

    // A volume mounted inside the root is not crossed by the walk; du crosses it and counts what is there.
    if (walked.skippedMounts > 0) {
        logger.debug(
            { path, skippedMounts: walked.skippedMounts, kib: walked.kib },
            "du size: the native walk left out mounted volumes, du runs"
        );
        return null;
    }

    logger.debug({ path, files: walked.files, walkMs: walked.walkMs, kib: walked.kib }, "du size: native walk");
    return walked;
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
    binary = ensureBinary,
}: {
    path: string;
    maxCacheAgeSeconds?: number;
    run?: CommandRunner;
    /** The native binary's path; compiled on demand by default. */
    binary?: () => string;
}): Promise<{ value: number | null; hit: boolean }> {
    const absolutePath = resolve(path);

    return cached<number | null>({
        storage,
        key: `sizes/${Bun.hash(absolutePath).toString(16)}.json`,
        maxAgeSeconds: maxCacheAgeSeconds,
        // Sessions that ask together after an install wait for one walk instead of each walking the folder.
        shareInFlight: `du/${absolutePath}`,
        fetch: async () => {
            const native = await nativeDuSize(absolutePath, { run, binary });

            if (native !== null) {
                return native.kib;
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
