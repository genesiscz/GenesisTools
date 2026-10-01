import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";

const { log } = logger.scoped("transcribe");

/** Converted audio is reused for an hour, then deleted on the next lookup. */
export const MEDIA_CACHE_TTL_MS = 60 * 60 * 1000;

interface CacheRecord {
    sourceId: string;
    createdAt: number;
    expiresAt: number;
    file: string;
}

export async function readMediaCache(dir: string, sourceId: string, now: number): Promise<string | null> {
    await sweepExpired(dir, now);
    const recordPath = recordFile(dir, sourceId);

    if (!existsSync(recordPath)) {
        return null;
    }

    const record = await readRecord(recordPath);

    if (!record || record.expiresAt <= now || record.sourceId !== sourceId) {
        await removeEntry(dir, sourceId, record);

        return null;
    }

    const audioPath = join(dir, record.file);

    if (!existsSync(audioPath)) {
        await removeEntry(dir, sourceId, record);

        return null;
    }

    return audioPath;
}

export async function writeMediaCache(
    dir: string,
    sourceId: string,
    sourceAudioPath: string,
    now: number
): Promise<string> {
    await mkdir(dir, { recursive: true });
    // The source keeps its own extension: an audio file the driver passes through unconverted
    // (wav, m4a) must not be cached under a name that claims mp3.
    const file = `${hashId(sourceId)}${extname(sourceAudioPath).toLowerCase() || ".mp3"}`;
    const audioPath = join(dir, file);
    const previous = await readRecord(recordFile(dir, sourceId));
    // Write to a unique name, then rename: two concurrent misses for the same source never
    // expose a half-copied file, and a reader that already opened the old one keeps its inode.
    const tmpSuffix = `.${process.pid}-${randomBytes(4).toString("hex")}.tmp`;
    const recordPath = recordFile(dir, sourceId);
    const record: CacheRecord = {
        sourceId,
        createdAt: now,
        expiresAt: now + MEDIA_CACHE_TTL_MS,
        file,
    };

    try {
        await copyFile(sourceAudioPath, `${audioPath}${tmpSuffix}`);
        await rename(`${audioPath}${tmpSuffix}`, audioPath);
        await writeFile(`${recordPath}${tmpSuffix}`, SafeJSON.stringify(record));
        await rename(`${recordPath}${tmpSuffix}`, recordPath);
    } finally {
        // A failed publish leaves no temp copy of the recording behind; a published file is untouched.
        for (const temp of [`${audioPath}${tmpSuffix}`, `${recordPath}${tmpSuffix}`]) {
            await rm(temp, { force: true }).catch((error: unknown) => {
                log.debug({ error, temp }, "transcribe cache temp delete failed");
            });
        }
    }

    if (previous && previous.file !== file) {
        await rm(join(dir, previous.file), { force: true }).catch((error: unknown) => {
            log.debug({ error, file: previous.file }, "transcribe cache old audio delete failed");
        });
    }

    log.info({ sourceId, file, expiresAt: record.expiresAt }, "cached converted audio");

    return audioPath;
}

async function sweepExpired(dir: string, now: number): Promise<void> {
    if (!existsSync(dir)) {
        return;
    }

    const names = await readdir(dir).catch((error: unknown) => {
        log.debug({ error, dir }, "transcribe cache sweep failed");

        return [] as string[];
    });

    for (const name of names) {
        if (!name.endsWith(".json")) {
            continue;
        }

        const record = await readRecord(join(dir, name));

        if (!record || record.expiresAt <= now) {
            await rm(join(dir, name), { force: true }).catch((error: unknown) => {
                log.debug({ error, name }, "transcribe cache record delete failed");
            });

            if (record) {
                await rm(join(dir, record.file), { force: true }).catch((error: unknown) => {
                    log.debug({ error, file: record.file }, "transcribe cache audio delete failed");
                });
            }
        }
    }
}

async function removeEntry(dir: string, sourceId: string, record: CacheRecord | null): Promise<void> {
    await rm(recordFile(dir, sourceId), { force: true }).catch((error: unknown) => {
        log.debug({ error, sourceId }, "transcribe cache record delete failed");
    });

    if (record) {
        await rm(join(dir, record.file), { force: true }).catch((error: unknown) => {
            log.debug({ error, file: record.file }, "transcribe cache audio delete failed");
        });
    }
}

async function readRecord(path: string): Promise<CacheRecord | null> {
    if (!existsSync(path)) {
        return null;
    }

    try {
        const parsed = SafeJSON.parse(await Bun.file(path).text()) as Partial<CacheRecord> | null;

        if (
            !parsed ||
            typeof parsed.sourceId !== "string" ||
            typeof parsed.createdAt !== "number" ||
            typeof parsed.expiresAt !== "number" ||
            typeof parsed.file !== "string"
        ) {
            return null;
        }

        return parsed as CacheRecord;
    } catch (error) {
        log.debug({ error, path }, "transcribe cache record was not json");

        return null;
    }
}

function recordFile(dir: string, sourceId: string): string {
    return join(dir, `${hashId(sourceId)}.json`);
}

function hashId(sourceId: string): string {
    return createHash("sha256").update(sourceId).digest("hex").slice(0, 32);
}
