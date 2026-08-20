import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { logger } from "@genesiscz/utils/logger";

const log = logger.scoped("ms-teams").log;

const OBJECT_RE = /\/objects\/(0-[a-z0-9-]+)\/views\/([a-z0-9_]+)/i;
const VIEW_RANK: Record<string, number> = {
    imgpsh_fullsize: 3,
    orig: 2,
    imgo: 1,
};

export interface CacheHit {
    objectId: string;
    view: string;
    path: string;
}

export function parseAmsObjectId(url: string | null | undefined): string | null {
    if (!url) {
        return null;
    }

    const match = url.match(OBJECT_RE);
    return match?.[1] ?? null;
}

export function extractImageBytes(data: Uint8Array): { bytes: Uint8Array; ext: "png" | "jpg" | "gif" | "webp" } | null {
    const png = indexOfBytes(data, new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

    if (png >= 0) {
        const iend = indexOfBytes(data, new Uint8Array([0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44]), png);

        if (iend >= 0) {
            return { bytes: data.slice(png, iend + 12), ext: "png" };
        }
    }

    const jpg = indexOfBytes(data, new Uint8Array([0xff, 0xd8, 0xff]));

    if (jpg >= 0) {
        const eoi = lastIndexOfBytes(data, new Uint8Array([0xff, 0xd9]));

        if (eoi > jpg) {
            return { bytes: data.slice(jpg, eoi + 2), ext: "jpg" };
        }
    }

    const gif = indexOfBytes(data, new TextEncoder().encode("GIF8"));

    if (gif >= 0) {
        return { bytes: data.slice(gif), ext: "gif" };
    }

    const riff = indexOfBytes(data, new TextEncoder().encode("RIFF"));
    const webp = indexOfBytes(data, new TextEncoder().encode("WEBP"));

    if (riff >= 0 && webp > riff) {
        return { bytes: data.slice(riff), ext: "webp" };
    }

    return null;
}

export function findDiskCacheImage(cacheDir: string, objectId: string): { bytes: Uint8Array; ext: string } | null {
    const hits = indexDiskCache(cacheDir).filter((h) => h.objectId === objectId);

    if (hits.length === 0) {
        return null;
    }

    hits.sort((a, b) => (VIEW_RANK[b.view] ?? 0) - (VIEW_RANK[a.view] ?? 0));

    for (const hit of hits) {
        try {
            const extracted = extractImageBytes(readFileSync(hit.path));

            if (extracted) {
                return extracted;
            }
        } catch (err) {
            log.debug({ err, path: hit.path }, "[ms-teams] disk-cache read failed");
        }
    }

    return null;
}

let cachedIndex: { dir: string; stamp: number; hits: CacheHit[] } | null = null;

export function indexDiskCache(cacheDir: string): CacheHit[] {
    if (!existsSync(cacheDir)) {
        return [];
    }

    const stamp = statSync(cacheDir).mtimeMs;

    if (cachedIndex && cachedIndex.dir === cacheDir && cachedIndex.stamp === stamp) {
        return cachedIndex.hits;
    }

    const hits: CacheHit[] = [];
    let names: string[] = [];

    try {
        names = readdirSync(cacheDir);
    } catch (err) {
        log.debug({ err, cacheDir }, "[ms-teams] could not list disk cache");
        return [];
    }

    for (const name of names) {
        if (name.startsWith(".")) {
            continue;
        }

        const path = join(cacheDir, name);

        try {
            if (!statSync(path).isFile()) {
                continue;
            }

            const head = readHead(path, 1024);
            const text = Buffer.from(head).toString("latin1");
            const match = text.match(OBJECT_RE);

            if (match) {
                hits.push({ objectId: match[1], view: match[2], path });
            }
        } catch (err) {
            log.debug({ err, path }, "[ms-teams] skip cache file");
        }
    }

    cachedIndex = { dir: cacheDir, stamp, hits };
    log.debug({ files: names.length, hits: hits.length }, "[ms-teams] indexed disk cache");
    return hits;
}

function readHead(path: string, size: number): Uint8Array {
    const fd = openSync(path, "r");

    try {
        const buf = Buffer.alloc(size);
        const n = readSync(fd, buf, 0, size, 0);
        return buf.subarray(0, n);
    } finally {
        closeSync(fd);
    }
}

function indexOfBytes(hay: Uint8Array, needle: Uint8Array, from = 0): number {
    outer: for (let i = from; i <= hay.length - needle.length; i++) {
        for (let j = 0; j < needle.length; j++) {
            if (hay[i + j] !== needle[j]) {
                continue outer;
            }
        }

        return i;
    }

    return -1;
}

function lastIndexOfBytes(hay: Uint8Array, needle: Uint8Array): number {
    outer: for (let i = hay.length - needle.length; i >= 0; i--) {
        for (let j = 0; j < needle.length; j++) {
            if (hay[i + j] !== needle[j]) {
                continue outer;
            }
        }

        return i;
    }

    return -1;
}
