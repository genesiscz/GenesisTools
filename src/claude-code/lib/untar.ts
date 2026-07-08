function readCString(block: Uint8Array, offset: number, length: number): string {
    let end = offset;

    while (end < offset + length && block[end] !== 0) {
        end++;
    }

    return new TextDecoder("latin1").decode(block.subarray(offset, end));
}

/**
 * Read-only, in-memory POSIX/ustar tar.gz reader. Returns file entries only
 * (typeflag '0' or NUL); directories, pax headers, and symlinks are skipped
 * (their payload is still consumed so offsets stay aligned).
 */
export function untarGz(body: Uint8Array): Map<string, Uint8Array> {
    const tar = Bun.gunzipSync(new Uint8Array(body));
    const entries = new Map<string, Uint8Array>();
    let off = 0;

    while (off + 512 <= tar.length) {
        const block = tar.subarray(off, off + 512);

        if (block.every((b) => b === 0)) {
            break;
        }

        const name = readCString(block, 0, 100);
        const prefix = readCString(block, 345, 155);
        const sizeField = readCString(block, 124, 12).trim();
        const size = sizeField.length > 0 ? Number.parseInt(sizeField, 8) : 0;
        const typeflag = block[156] ?? 0;
        const full = prefix.length > 0 ? `${prefix}/${name}` : name;
        off += 512;

        const isFile = typeflag === 48 || typeflag === 0;

        if (isFile && full.length > 0) {
            if (full.split("/").includes("..")) {
                throw new Error(`tar path traversal rejected: ${full}`);
            }

            entries.set(full, tar.subarray(off, off + size));
        }

        off += Math.ceil(size / 512) * 512;
    }

    return entries;
}
