import { chmodSync, closeSync, existsSync, mkdirSync, openSync, renameSync, unlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { logger } from "@genesiscz/utils/logger";
import { atomicWriteIo, isMissingFileError } from "@genesiscz/utils/storage/atomic-file";
import { assertTestSafePath } from "@genesiscz/utils/storage/real-home-guard";
import { type ContentDigest, verifyCompressedFile } from "./file";
import { type LedgerRecord, recordCompression } from "./ledger";
import { PRESETS, type PresetName } from "./presets";
import { type SeekableWriterStats, SeekableZstdWriter, type ZstdParams } from "./zstd";

/**
 * Compressing bytes that are not a file yet (a stream, lines picked out of a log) with nothing left half-written.
 * The bytes go into `<target>.<pid>.<n>.partial` through {@link SeekableZstdWriter}, hashed on the way in. `commit()`
 * finishes the frames, fsyncs, reads the file back (decompressed size and sha256 must equal what was pushed) and only
 * then renames it over the target. Any failure removes the partial and leaves an existing target as it was. A
 * {@link VerifiedZstdBatch} verifies every output before it renames the first, so several files land together.
 */

export interface VerifiedZstdOptions extends ZstdParams {
    /** Who asked, recorded in the ledger (`cli`, `logs`, a hook's name): pass a new name for a new automatic pass. */
    caller: string;
    /** Frame and level settings from {@link PRESETS}; default `text` (level 3, line-aligned 4 MiB frames). */
    preset?: PresetName;
    /** Overrides the preset's frame size. */
    frameBytes?: number;
    /** Overrides the preset: frames start on a line. */
    lineAligned?: boolean;
    /** Overrides the preset: frames compressed at once on the thread pool. */
    threads?: number;
    /** File mode of the result, applied past the umask (`0o600` for private data); default 0666 minus the umask. */
    mode?: number;
    /** Where the bytes came from, for the ledger's `source` (the log a rotation read); default `stream`. */
    source?: string;
}

export interface VerifiedZstdResult extends ContentDigest {
    /** The absolute path written. */
    target: string;
    compressedBytes: number;
    frames: number;
    record: LedgerRecord;
}

/** `open` takes bytes; `verified` read back fine and waits for its batch to rename it; the last two are final. */
export type VerifiedZstdState = "open" | "verified" | "committed" | "aborted";

export interface VerifiedZstdWriter {
    /** The absolute path the output is renamed to on commit. */
    readonly target: string;
    /** The file being written: `<target>.<pid>.<n>.partial`, next to the target. */
    readonly partialPath: string;
    readonly state: VerifiedZstdState;
    /** Appends bytes (a string is written as UTF-8). Await each push before the next. A failure aborts the writer. */
    push(bytes: Uint8Array | string): Promise<void>;
    /**
     * Finishes, verifies and renames over the target, then records the ledger entry. Throws (and removes the partial,
     * leaving an existing target untouched) when the read-back differs: {@link ZstdVerificationError}. A writer from a
     * batch is committed by its batch.
     */
    commit(): Promise<VerifiedZstdResult>;
    /** Removes the partial. Safe to call at any time; does nothing after a commit or a second time. */
    abort(): void;
}

export interface VerifiedZstdBatch {
    readonly writers: readonly VerifiedZstdWriter[];
    /** A writer for one more output, with the batch's options and `overrides`. One writer per target. */
    add(target: string, overrides?: Omit<Partial<VerifiedZstdOptions>, "caller">): VerifiedZstdWriter;
    /**
     * Verifies every writer, then renames them all. When one fails to verify (or was aborted), every partial is
     * removed, no target changes, and the error is thrown. The renames run only after all verified; a rename that
     * fails then (the folder removed meanwhile) leaves the outputs renamed before it in place and removes the rest.
     */
    commit(): Promise<VerifiedZstdResult[]>;
    /** Aborts every writer. */
    abort(): void;
}

/** A compressed output that did not read back to the bytes pushed into it. */
export class ZstdVerificationError extends Error {
    readonly targets: string[];

    constructor(message: string, targets: string[], options?: { cause?: unknown }) {
        super(message, options);
        this.name = "ZstdVerificationError";
        this.targets = targets;
    }
}

let partialCounter = 0;

function removePartial(path: string): void {
    try {
        unlinkSync(path);
    } catch (err) {
        if (!isMissingFileError(err)) {
            logger.warn({ err, path }, "[compress] could not remove a partial compressed file");
        }
    }
}

class Writer implements VerifiedZstdWriter {
    readonly target: string;
    readonly partialPath: string;
    private readonly options: VerifiedZstdOptions;
    private readonly presetName: PresetName;
    private readonly settings: Required<Pick<VerifiedZstdOptions, "level" | "long" | "frameBytes" | "threads">>;
    private readonly frames: SeekableZstdWriter;
    private readonly inputHash = new Bun.CryptoHasher("sha256");
    private readonly outputHash = new Bun.CryptoHasher("sha256");
    private readonly startedAt = new Date().toISOString();
    private readonly batched: boolean;
    private fd: number | undefined;
    private current: VerifiedZstdState = "open";
    private sealed: { digest: ContentDigest; stats: SeekableWriterStats } | undefined;

    constructor(target: string, options: VerifiedZstdOptions, batched: boolean) {
        this.target = resolve(target);
        this.options = options;
        this.batched = batched;
        this.presetName = options.preset ?? "text";
        const preset = PRESETS[this.presetName];
        this.settings = {
            level: options.level ?? preset.level,
            long: options.long ?? preset.long,
            frameBytes: options.frameBytes ?? preset.frameBytes,
            threads: options.threads ?? preset.threads,
        };
        assertTestSafePath(this.target, "write");

        const dir = dirname(this.target);

        if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
        }

        this.partialPath = `${this.target}.${process.pid}.${partialCounter++}.partial`;
        this.fd = openSync(this.partialPath, "wx", options.mode ?? 0o666);
        this.frames = new SeekableZstdWriter({
            write: (bytes) => this.write(bytes),
            ...this.settings,
            checksum: options.checksum,
            lineAligned: options.lineAligned ?? preset.lineAligned,
        });
    }

    get state(): VerifiedZstdState {
        return this.current;
    }

    async push(bytes: Uint8Array | string): Promise<void> {
        this.assertOpen("push to");
        const view = typeof bytes === "string" ? Buffer.from(bytes, "utf8") : bytes;

        try {
            this.inputHash.update(view);
            await this.frames.push(view);
        } catch (err) {
            this.abort();
            throw err;
        }
    }

    async commit(): Promise<VerifiedZstdResult> {
        if (this.batched) {
            throw new Error(`${this.target} belongs to a batch: commit the batch`);
        }

        await this.verify();
        return this.publish();
    }

    abort(): void {
        if (this.current === "committed" || this.current === "aborted") {
            return;
        }

        this.current = "aborted";
        this.closeFile();
        removePartial(this.partialPath);
    }

    /** Finishes the frames, flushes the partial and reads it back; on any failure the writer is aborted. */
    async verify(): Promise<void> {
        this.assertOpen("commit");

        try {
            const stats = await this.frames.finish();
            const fd = this.fd;

            if (fd !== undefined) {
                atomicWriteIo.fsyncSync(fd);
            }

            this.closeFile();

            // The open's mode is masked by umask; re-applied so a private output is never published wider.
            if (this.options.mode !== undefined) {
                chmodSync(this.partialPath, this.options.mode);
            }

            const digest: ContentDigest = { bytes: stats.inputBytes, sha256: this.inputHash.digest("hex") };

            if (!verifyCompressedFile(this.partialPath, digest)) {
                throw new ZstdVerificationError(
                    `${this.target}: the compressed output did not read back to the ${digest.bytes} bytes pushed into it; the partial was removed and the target left as it was`,
                    [this.target]
                );
            }

            this.sealed = { digest, stats };
            this.current = "verified";
        } catch (err) {
            this.abort();
            throw err;
        }
    }

    /** Renames a verified partial over the target and records it in the ledger. */
    publish(): VerifiedZstdResult {
        const sealed = this.sealed;

        if (this.current !== "verified" || !sealed) {
            throw new Error(`${this.target}: only a verified output can be renamed (state ${this.current})`);
        }

        try {
            renameSync(this.partialPath, this.target);
        } catch (err) {
            this.abort();
            throw new Error(`Rename failed: ${this.partialPath} → ${this.target}`, { cause: err });
        }

        this.current = "committed";
        const { digest, stats } = sealed;
        const record = recordCompression({
            op: "compress",
            caller: this.options.caller,
            source: this.options.source ?? "stream",
            target: this.target,
            sourceBytes: digest.bytes,
            targetBytes: stats.outputBytes,
            ratio: digest.bytes / Math.max(stats.outputBytes, 1),
            preset: this.presetName,
            ...this.settings,
            inputSha256: digest.sha256,
            outputSha256: this.outputHash.digest("hex"),
            removedOriginal: false,
            startedAt: this.startedAt,
            endedAt: new Date().toISOString(),
        });

        return {
            target: this.target,
            bytes: digest.bytes,
            sha256: digest.sha256,
            compressedBytes: stats.outputBytes,
            frames: stats.frames,
            record,
        };
    }

    private write(bytes: Uint8Array): void {
        const fd = this.fd;

        if (fd === undefined) {
            throw new Error(`${this.partialPath} is closed`);
        }

        this.outputHash.update(bytes);
        let offset = 0;

        while (offset < bytes.length) {
            offset += atomicWriteIo.writeSync(fd, bytes, offset, bytes.length - offset);
        }
    }

    private closeFile(): void {
        const fd = this.fd;
        this.fd = undefined;

        if (fd === undefined) {
            return;
        }

        try {
            closeSync(fd);
        } catch (err) {
            logger.debug({ err, path: this.partialPath }, "[compress] closing a partial compressed file failed");
        }
    }

    private assertOpen(action: string): void {
        if (this.current !== "open") {
            throw new Error(`Cannot ${action} ${this.target}: the writer is ${this.current}`);
        }
    }
}

class Batch implements VerifiedZstdBatch {
    private readonly options: VerifiedZstdOptions;
    private readonly members: Writer[] = [];
    private current: "open" | "committed" | "aborted" = "open";

    constructor(options: VerifiedZstdOptions) {
        this.options = options;
    }

    get writers(): readonly VerifiedZstdWriter[] {
        return this.members;
    }

    add(target: string, overrides: Omit<Partial<VerifiedZstdOptions>, "caller"> = {}): VerifiedZstdWriter {
        this.assertOpen();
        const absolute = resolve(target);

        if (this.members.some((writer) => writer.target === absolute)) {
            throw new Error(`${absolute} already has a writer in this batch`);
        }

        const writer = new Writer(absolute, { ...this.options, ...overrides }, true);
        this.members.push(writer);
        return writer;
    }

    async commit(): Promise<VerifiedZstdResult[]> {
        this.assertOpen();

        for (const writer of this.members) {
            if (writer.state !== "open") {
                this.abort();
                throw new ZstdVerificationError(
                    `${writer.target} was ${writer.state} before the batch commit; no output of the batch was renamed`,
                    [writer.target]
                );
            }

            try {
                await writer.verify();
            } catch (err) {
                this.abort();
                const targets = err instanceof ZstdVerificationError ? err.targets : [writer.target];
                throw new ZstdVerificationError(
                    `${writer.target} failed before the batch commit (${err instanceof Error ? err.message : String(err)}); no output of the batch was renamed`,
                    targets,
                    { cause: err }
                );
            }
        }

        const results: VerifiedZstdResult[] = [];

        for (const writer of this.members) {
            try {
                results.push(writer.publish());
            } catch (err) {
                this.abort();
                const renamed = results.map((result) => result.target).join(", ") || "none";
                throw new Error(`${writer.target} could not be renamed after the batch verified; renamed: ${renamed}`, {
                    cause: err,
                });
            }
        }

        this.current = "committed";
        return results;
    }

    abort(): void {
        if (this.current !== "open") {
            return;
        }

        this.current = "aborted";

        for (const writer of this.members) {
            writer.abort();
        }
    }

    private assertOpen(): void {
        if (this.current !== "open") {
            throw new Error(`The batch is ${this.current}`);
        }
    }
}

/** A {@link VerifiedZstdWriter} for one output. Call `abort()` in a `catch` or `finally`: it is a no-op once committed. */
export function createVerifiedZstdWriter(target: string, options: VerifiedZstdOptions): VerifiedZstdWriter {
    return new Writer(target, options, false);
}

/** A {@link VerifiedZstdBatch}: several outputs that are renamed together, or not at all. */
export function createVerifiedZstdBatch(options: VerifiedZstdOptions): VerifiedZstdBatch {
    return new Batch(options);
}

export interface CompressStreamOptions extends VerifiedZstdOptions {
    target: string;
}

/**
 * Compresses every chunk of `chunks` into `target` through a {@link VerifiedZstdWriter}: written to a partial, read
 * back, renamed. A failure in the source, the write or the read-back removes the partial and rethrows.
 */
export async function compressStream(
    chunks: AsyncIterable<Uint8Array | string> | Iterable<Uint8Array | string>,
    { target, ...options }: CompressStreamOptions
): Promise<VerifiedZstdResult> {
    const writer = createVerifiedZstdWriter(target, options);

    try {
        for await (const chunk of chunks) {
            await writer.push(chunk);
        }

        return await writer.commit();
    } finally {
        writer.abort();
    }
}
