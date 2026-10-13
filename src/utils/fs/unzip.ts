import { inflateRawSync } from "node:zlib";

const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CENTRAL_DIRECTORY_ENTRY = 0x02014b50;
const LOCAL_FILE_HEADER = 0x04034b50;

/**
 * Reads a ZIP archive into a name -> bytes map. Handles stored and deflated entries, which is what zip tools
 * and Sentry artifact bundles write; ZIP64 and encrypted archives throw. Directory entries are skipped.
 */
export function unzip(body: Uint8Array): Map<string, Uint8Array> {
    const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
    let end = -1;
    // The end record is 22 bytes plus a comment of at most 65535 bytes, so it sits within that distance of the end.
    for (let at = body.length - 22; at >= Math.max(0, body.length - 22 - 0xffff); at--) {
        if (view.getUint32(at, true) === END_OF_CENTRAL_DIRECTORY) {
            end = at;
            break;
        }
    }

    if (end < 0) {
        throw new Error("not a zip archive (no end-of-central-directory record)");
    }

    const count = view.getUint16(end + 10, true);
    let pointer = view.getUint32(end + 16, true);
    const decoder = new TextDecoder();
    const files = new Map<string, Uint8Array>();
    for (let index = 0; index < count; index++) {
        if (view.getUint32(pointer, true) !== CENTRAL_DIRECTORY_ENTRY) {
            throw new Error(`corrupt zip: central directory entry ${index} has no signature`);
        }

        const method = view.getUint16(pointer + 10, true);
        const compressedSize = view.getUint32(pointer + 20, true);
        const nameLength = view.getUint16(pointer + 28, true);
        const extraLength = view.getUint16(pointer + 30, true);
        const commentLength = view.getUint16(pointer + 32, true);
        const localOffset = view.getUint32(pointer + 42, true);
        const name = decoder.decode(body.subarray(pointer + 46, pointer + 46 + nameLength));
        pointer += 46 + nameLength + extraLength + commentLength;
        if (compressedSize === 0xffffffff || localOffset === 0xffffffff) {
            throw new Error(`ZIP64 archives are not supported (${name})`);
        }

        if (name.endsWith("/")) {
            continue;
        }

        if (view.getUint32(localOffset, true) !== LOCAL_FILE_HEADER) {
            throw new Error(`corrupt zip: ${name} has no local file header`);
        }

        const start =
            localOffset + 30 + view.getUint16(localOffset + 26, true) + view.getUint16(localOffset + 28, true);
        const data = body.subarray(start, start + compressedSize);
        if (method === 0) {
            files.set(name, data.slice());
        } else if (method === 8) {
            files.set(name, new Uint8Array(inflateRawSync(data)));
        } else {
            throw new Error(`unsupported zip compression method ${method} (${name})`);
        }
    }

    return files;
}
