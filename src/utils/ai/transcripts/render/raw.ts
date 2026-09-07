import { existsSync, readFileSync } from "node:fs";
import type { TranscriptEnvelope } from "../types";
import { type RenderContext, TranscriptRenderer } from "./renderer";

const NEWLINE = 0x0a;

/**
 * The provider's own lines, unparsed, from the transcript's current file. A
 * worker session is a chain of turn files; this prints the file the resolver
 * points at (the latest turn) and, in follow mode, only the bytes appended since
 * the previous envelope. Use the jsonl or json formats for the whole chain.
 *
 * Bytes after the last newline are held until the next read: a size snapshot
 * can land inside a record or inside a multi-byte code point, and decoding the
 * fragment on its own printed one JSONL record as two lines with U+FFFD in the
 * seam (PR #364 review). `close()` flushes a final unterminated record.
 */
export class RawRenderer extends TranscriptRenderer {
    readonly format = "raw";
    private filePath: string | null = null;
    private offset = 0;
    private pending: Buffer = Buffer.alloc(0);

    envelope(envelope: TranscriptEnvelope, ctx: RenderContext): void {
        if (!existsSync(envelope.filePath)) {
            return;
        }

        if (envelope.filePath !== this.filePath) {
            this.flushPending(ctx);
            this.filePath = envelope.filePath;
            this.offset = 0;
        }

        const bytes = readFileSync(envelope.filePath);
        if (bytes.length <= this.offset) {
            return;
        }

        const buffered = Buffer.concat([this.pending, bytes.subarray(this.offset)]);
        this.offset = bytes.length;

        const cut = buffered.lastIndexOf(NEWLINE);
        if (cut === -1) {
            this.pending = buffered;
            return;
        }

        this.pending = buffered.subarray(cut + 1);
        // Every line up to and including the last newline; a blank line is a
        // real line of the file and stays.
        for (const line of buffered.subarray(0, cut).toString("utf8").split("\n")) {
            ctx.write(line);
        }
    }

    close(ctx: RenderContext): void {
        this.flushPending(ctx);
    }

    private flushPending(ctx: RenderContext): void {
        if (this.pending.length > 0) {
            ctx.write(this.pending.toString("utf8"));
            this.pending = Buffer.alloc(0);
        }
    }
}
