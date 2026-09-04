import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { logger } from "@genesiscz/utils/logger";
import { liveIndexedDbParent } from "./paths";

const log = logger.scoped("ms-teams").log;

export type ProbeEncoding = "utf8" | "utf16le";

export interface ProbeHit {
    file: string;
    encoding: ProbeEncoding;
}

export interface ProbeResult {
    indexedDbDir: string;
    present: boolean;
    filesScanned: number;
    hits: ProbeHit[];
}

function indexOfBuffer(hay: Buffer, needle: Buffer): number {
    return hay.indexOf(needle);
}

export function encodingsFor(needle: string): { encoding: ProbeEncoding; buf: Buffer }[] {
    return [
        { encoding: "utf8", buf: Buffer.from(needle, "utf8") },
        { encoding: "utf16le", buf: Buffer.from(needle, "utf16le") },
    ];
}

export function listLeveldbFiles(indexedDbDir: string): string[] {
    if (!existsSync(indexedDbDir)) {
        return [];
    }

    const out: string[] = [];

    for (const name of readdirSync(indexedDbDir)) {
        if (!name.startsWith("https_teams.microsoft.com_") || !name.endsWith(".indexeddb.leveldb")) {
            continue;
        }

        const dir = join(indexedDbDir, name);

        if (!statSync(dir).isDirectory()) {
            continue;
        }

        for (const file of readdirSync(dir)) {
            out.push(join(dir, file));
        }
    }

    return out;
}

export function probeIndexedDb(opts: { needle: string; indexedDbDir?: string }): ProbeResult {
    const indexedDbDir = opts.indexedDbDir ?? liveIndexedDbParent();
    const present = existsSync(indexedDbDir);

    if (!present || opts.needle.length === 0) {
        return { indexedDbDir, present, filesScanned: 0, hits: [] };
    }

    const files = listLeveldbFiles(indexedDbDir);
    const encodings = encodingsFor(opts.needle);
    const hits: ProbeHit[] = [];

    for (const file of files) {
        let buf: Buffer;

        try {
            buf = readFileSync(file);
        } catch (err) {
            log.debug({ err, file }, "[ms-teams] probe skip unreadable file");
            continue;
        }

        for (const enc of encodings) {
            if (indexOfBuffer(buf, enc.buf) >= 0) {
                hits.push({ file, encoding: enc.encoding });
                break;
            }
        }
    }

    log.debug(
        { needle: opts.needle, files: files.length, hits: hits.length, indexedDbDir },
        "[ms-teams] live IndexedDB probe"
    );
    return { indexedDbDir, present, filesScanned: files.length, hits };
}
