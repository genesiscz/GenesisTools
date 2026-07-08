import { Buffer } from "node:buffer";
import { gunzipSync } from "node:zlib";
import { extract, pack } from "tar-stream";

export interface TarEntry {
    path: string;
    data: Uint8Array;
}

const MAX_DECOMPRESSED_BYTES = 500 * 1024 * 1024; // 500 MiB ceiling on the extracted tar body

/** Unpack a gzipped tar body into memory. Rejects absolute / traversal paths. */
export async function untarGz(body: Uint8Array): Promise<TarEntry[]> {
    // node:zlib's maxOutputLength aborts mid-inflation, so a gzip bomb can't materialize the
    // full tar in memory before the cap runs (Bun.gunzipSync has no such bound).
    let tarBuf: Buffer;
    try {
        tarBuf = gunzipSync(Buffer.from(body), { maxOutputLength: MAX_DECOMPRESSED_BYTES });
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE") {
            throw new Error(`tar body exceeds ${MAX_DECOMPRESSED_BYTES} bytes decompressed`, { cause: err });
        }
        throw err;
    }
    const ex = extract();
    const entries: TarEntry[] = [];
    let totalBytes = 0;
    const done = new Promise<void>((resolve, reject) => {
        ex.on("entry", (header, stream, next) => {
            const chunks: Buffer[] = [];
            stream.on("data", (c: Buffer) => {
                totalBytes += c.length;
                if (totalBytes > MAX_DECOMPRESSED_BYTES) {
                    reject(new Error(`tar body exceeds ${MAX_DECOMPRESSED_BYTES} bytes decompressed`));
                    ex.destroy();
                    return;
                }
                chunks.push(c);
            });
            stream.on("end", () => {
                if (header.type === "file") {
                    const clean = header.name.replace(/^\.\//, "");
                    const parts = clean.split("/");
                    if (!clean.startsWith("/") && !parts.includes("..") && clean.length > 0) {
                        entries.push({ path: clean, data: new Uint8Array(Buffer.concat(chunks)) });
                    }
                }
                next();
            });
            stream.on("error", reject);
        });
        ex.on("finish", () => resolve());
        ex.on("error", reject);
    });
    ex.end(tarBuf);
    await done;
    return entries;
}

/** Pack entries into a gzipped tar (CLI push uses this). */
export async function tarGz(entries: TarEntry[]): Promise<Uint8Array> {
    const p = pack();
    const chunks: Buffer[] = [];
    const done = new Promise<void>((resolve, reject) => {
        p.on("data", (c: Buffer) => chunks.push(c));
        p.on("end", () => resolve());
        p.on("error", reject);
    });
    for (const e of entries) {
        // Same Uint8Array<ArrayBufferLike> vs. Uint8Array<ArrayBuffer> quirk as above.
        p.entry({ name: e.path }, Buffer.from(new Uint8Array(e.data)));
    }
    p.finalize();
    await done;
    return Bun.gzipSync(new Uint8Array(Buffer.concat(chunks)));
}
