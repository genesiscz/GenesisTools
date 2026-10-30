import { crc32, deflateRawSync } from "node:zlib";

const LOCAL_FILE_HEADER = 0x04034b50;
const CENTRAL_DIRECTORY_ENTRY = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const VERSION = 20;
const UTF8_NAMES = 0x0800;
const MAX_ENTRIES = 0xffff;
const MAX_BYTES = 0xffffffff;
const ZIP_WORKER_TIMEOUT_MS = 120_000;

export interface ZipEntry {
    /** Forward-slash path inside the archive. */
    name: string;
    data: Uint8Array;
    modified?: Date;
}

function dosDateTime(date: Date): { time: number; day: number } {
    const year = Math.max(1980, date.getFullYear());

    return {
        time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
        day: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
    };
}

/**
 * Writes a ZIP archive that `unzip` (and every zip tool) reads. An entry is deflated only when that makes it
 * smaller, so already-compressed images are stored as they are. ZIP64 is not written: more than 65535 entries
 * or 4 GiB throws.
 */
export function zip(entries: ZipEntry[]): Uint8Array {
    if (entries.length > MAX_ENTRIES) {
        throw new Error(`zip: ${entries.length} entries need ZIP64, which is not supported`);
    }

    const encoder = new TextEncoder();
    const locals: Uint8Array[] = [];
    const centrals: Uint8Array[] = [];
    let offset = 0;

    for (const entry of entries) {
        const name = encoder.encode(entry.name);
        const deflated = deflateRawSync(entry.data);
        const stored = deflated.length >= entry.data.length;
        const body = stored ? entry.data : deflated;
        const checksum = crc32(entry.data);
        const { time, day } = dosDateTime(entry.modified ?? new Date());

        if (entry.data.length > MAX_BYTES || offset > MAX_BYTES) {
            throw new Error(`zip: ${entry.name} needs ZIP64, which is not supported`);
        }

        const local = new Uint8Array(30 + name.length);
        const lv = new DataView(local.buffer);
        lv.setUint32(0, LOCAL_FILE_HEADER, true);
        lv.setUint16(4, VERSION, true);
        lv.setUint16(6, UTF8_NAMES, true);
        lv.setUint16(8, stored ? 0 : 8, true);
        lv.setUint16(10, time, true);
        lv.setUint16(12, day, true);
        lv.setUint32(14, checksum, true);
        lv.setUint32(18, body.length, true);
        lv.setUint32(22, entry.data.length, true);
        lv.setUint16(26, name.length, true);
        local.set(name, 30);

        const central = new Uint8Array(46 + name.length);
        const cv = new DataView(central.buffer);
        cv.setUint32(0, CENTRAL_DIRECTORY_ENTRY, true);
        cv.setUint16(4, VERSION, true);
        cv.setUint16(6, VERSION, true);
        cv.setUint16(8, UTF8_NAMES, true);
        cv.setUint16(10, stored ? 0 : 8, true);
        cv.setUint16(12, time, true);
        cv.setUint16(14, day, true);
        cv.setUint32(16, checksum, true);
        cv.setUint32(20, body.length, true);
        cv.setUint32(24, entry.data.length, true);
        cv.setUint16(28, name.length, true);
        cv.setUint32(42, offset, true);
        central.set(name, 46);

        locals.push(local, body);
        centrals.push(central);
        offset += local.length + body.length;
    }

    const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);

    if (offset + centralSize > MAX_BYTES) {
        throw new Error("zip: the archive needs ZIP64, which is not supported");
    }

    const end = new Uint8Array(22);
    const ev = new DataView(end.buffer);
    ev.setUint32(0, END_OF_CENTRAL_DIRECTORY, true);
    ev.setUint16(8, entries.length, true);
    ev.setUint16(10, entries.length, true);
    ev.setUint32(12, centralSize, true);
    ev.setUint32(16, offset, true);

    const parts = [...locals, ...centrals, end];
    const out = new Uint8Array(offset + centralSize + end.length);
    let at = 0;

    for (const part of parts) {
        out.set(part, at);
        at += part.length;
    }

    return out;
}

/** Compress and assemble the archive away from the caller's event loop. */
export function zipAsync(entries: ZipEntry[]): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
        const worker = new Worker(new URL("./zip-worker.ts", import.meta.url).href);
        let settled = false;
        const timer = setTimeout(() => {
            if (finish()) {
                reject(new Error(`zip worker timed out after ${ZIP_WORKER_TIMEOUT_MS} ms`));
            }
        }, ZIP_WORKER_TIMEOUT_MS);

        function finish(): boolean {
            if (settled) {
                return false;
            }

            settled = true;
            clearTimeout(timer);
            worker.terminate();
            return true;
        }

        worker.onmessage = (event: MessageEvent<{ body?: Uint8Array; error?: string }>) => {
            if (!finish()) {
                return;
            }

            if (event.data.body) {
                resolve(event.data.body);
            } else {
                reject(new Error(event.data.error ?? "zip worker failed"));
            }
        };
        worker.onerror = (event) => {
            if (finish()) {
                reject(new Error(event.message));
            }
        };
        try {
            worker.postMessage(entries);
        } catch (error) {
            if (finish()) {
                reject(error);
            }
        }
    });
}
