import { constants } from "node:fs";
import { copyFile, lstat, realpath, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { Refusal } from "./browser";

export async function fileEvidence(file: string, contains: string[] = []) {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new Refusal("Expected one regular file without a symlink.");
    }
    if (stat.size > 20_000_000) {
        throw new Refusal("Output verification is limited to files up to 20 MB.");
    }
    const bytes = await Bun.file(file).arrayBuffer();
    const text = new TextDecoder().decode(bytes);
    for (const expected of contains) {
        if (!text.includes(expected)) {
            throw new Error("Output content check failed.");
        }
    }
    return { path: file, size: bytes.byteLength, sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex") };
}
export async function moveVerified(options: {
    source: string;
    destination: string;
    filename: string;
    contains: string[];
    signal?: AbortSignal;
    onDispatch: () => void;
}) {
    if (!isAbsolute(options.destination) || !isAbsolute(options.source)) {
        throw new Refusal("File paths must be absolute.");
    }
    if (
        !options.filename ||
        basename(options.filename) !== options.filename ||
        [".", ".."].includes(options.filename)
    ) {
        throw new Refusal("Filename must be one plain filename, without directory traversal.");
    }
    const destination = resolve(options.destination);
    if ((await realpath(destination)) !== destination || !(await lstat(destination)).isDirectory()) {
        throw new Refusal("Destination must be an existing directory without symlink components.");
    }
    if ((await realpath(dirname(options.source))) !== resolve(dirname(options.source))) {
        throw new Refusal("Source directory must not contain symlink components.");
    }
    const target = join(destination, options.filename);
    const before = await fileEvidence(options.source, options.contains);
    options.signal?.throwIfAborted();
    try {
        await lstat(target);
        throw new Refusal("Destination already exists; it will not be overwritten.");
    } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
            throw error;
        }
    }
    options.signal?.throwIfAborted();
    options.onDispatch();
    await copyFile(options.source, target, constants.COPYFILE_EXCL);
    const after = await fileEvidence(target, options.contains);
    if (before.sha256 !== after.sha256 || (await fileEvidence(options.source)).sha256 !== before.sha256) {
        throw new Error("File changed during the move; both files are retained for repair.");
    }
    await unlink(options.source);
    return after;
}
