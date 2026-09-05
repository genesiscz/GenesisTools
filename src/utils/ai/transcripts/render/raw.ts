import { existsSync, readFileSync } from "node:fs";
import type { TranscriptEnvelope } from "../types";
import { type RenderContext, TranscriptRenderer } from "./renderer";

/**
 * The provider's own lines, unparsed, from the transcript's current file. A
 * worker session is a chain of turn files; this prints the file the resolver
 * points at (the latest turn) and, in follow mode, only the bytes appended since
 * the previous envelope. Use the jsonl or json formats for the whole chain.
 */
export class RawRenderer extends TranscriptRenderer {
    readonly format = "raw";
    private filePath: string | null = null;
    private offset = 0;

    envelope(envelope: TranscriptEnvelope, ctx: RenderContext): void {
        if (!existsSync(envelope.filePath)) {
            return;
        }

        if (envelope.filePath !== this.filePath) {
            this.filePath = envelope.filePath;
            this.offset = 0;
        }

        const bytes = readFileSync(envelope.filePath);
        if (bytes.length <= this.offset) {
            return;
        }

        const chunk = bytes.subarray(this.offset, bytes.length).toString("utf8");
        this.offset = bytes.length;
        for (const line of chunk.split("\n")) {
            if (line) {
                ctx.write(line);
            }
        }
    }
}
