import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { stripAnsi } from "@app/utils/string";
import { inferLineLevel } from "./infer-line-level";
import { JsonlWriter } from "./jsonl-writer";
import type { StreamOut } from "./types";

export type CaptureMode = "pty" | "pipe";

export interface OrderedCaptureWriterOptions {
    jsonlPath: string;
    uiJsonlPath?: string;
    stdoutPath: string;
    stderrPath: string;
    mode: CaptureMode;
    /** Continue seq numbering from an existing session (reuse-continue). */
    initialSeq?: number;
}

export class OrderedCaptureWriter {
    private readonly jsonlWriter: JsonlWriter;
    private readonly uiJsonlWriter: JsonlWriter | null;
    private readonly mode: CaptureMode;
    private queue: Array<{ out: StreamOut; chunk: string }> = [];
    private seq = 0;
    private draining = false;
    private stdoutPartial = "";
    private stderrPartial = "";

    constructor(private readonly opts: OrderedCaptureWriterOptions) {
        this.jsonlWriter = new JsonlWriter(opts.jsonlPath);
        this.uiJsonlWriter = opts.uiJsonlPath ? new JsonlWriter(opts.uiJsonlPath) : null;
        this.mode = opts.mode;
        this.seq = opts.initialSeq ?? 0;
        mkdirSync(dirname(opts.jsonlPath), { recursive: true });
        mkdirSync(dirname(opts.stdoutPath), { recursive: true });
        mkdirSync(dirname(opts.stderrPath), { recursive: true });
        if (!existsSync(opts.stdoutPath)) {
            writeFileSync(opts.stdoutPath, "");
        }

        if (!existsSync(opts.stderrPath)) {
            writeFileSync(opts.stderrPath, "");
        }

        if (opts.uiJsonlPath && !existsSync(opts.uiJsonlPath)) {
            writeFileSync(opts.uiJsonlPath, "");
        }
    }

    enqueue(out: StreamOut, chunk: string): void {
        this.queue.push({ out, chunk });
        void this.drain();
    }

    async flush(): Promise<void> {
        while (this.queue.length > 0 || this.draining) {
            await this.drain();
            if (this.queue.length === 0 && !this.draining) {
                break;
            }

            await Bun.sleep(1);
        }

        this.flushPartial("stdout");
        this.flushPartial("stderr");
    }

    getSeq(): number {
        return this.seq;
    }

    private async drain(): Promise<void> {
        if (this.draining) {
            return;
        }

        this.draining = true;

        while (this.queue.length > 0) {
            const item = this.queue.shift();
            if (!item) {
                break;
            }

            const lines = this.extractLines(item.out, item.chunk);
            for (const text of lines) {
                this.seq += 1;
                const outStream: StreamOut = this.mode === "pty" ? "stdout" : item.out;
                const plain = stripAnsi(text);
                this.appendUiLine(this.seq, text);
                const record = {
                    type: "line" as const,
                    seq: this.seq,
                    out: outStream,
                    level: inferLineLevel(outStream, plain),
                    ts: Date.now(),
                    text: plain,
                    raw: text,
                };
                this.jsonlWriter.append(record);
                this.appendPlainMirror(outStream, record.text);
            }
        }

        this.draining = false;
    }

    private extractLines(out: StreamOut, chunk: string): string[] {
        const partialKey = out === "stdout" ? "stdoutPartial" : "stderrPartial";
        let partial = this[partialKey];
        partial += chunk;
        const parts = partial.split("\n");
        const remainder = parts.pop() ?? "";
        this[partialKey] = remainder;

        // Every part-before-the-pop'd-remainder was terminated by a real
        // \n in the input; emit ALL of them — empty lines included. The
        // prior `filter(line.length > 0 || parts.length > 1)` dropped lone
        // empty lines arriving as chunk "\n" while preserving them when
        // they arrived as "\n\n", so the recorded line count depended on
        // child-flush timing instead of the actual newline count.
        return parts;
    }

    private flushPartial(out: StreamOut): void {
        const partialKey = out === "stdout" ? "stdoutPartial" : "stderrPartial";
        const partial = this[partialKey];

        if (!partial) {
            return;
        }

        this[partialKey] = "";
        this.seq += 1;
        const outStream: StreamOut = this.mode === "pty" ? "stdout" : out;
        const plain = stripAnsi(partial);
        this.appendUiLine(this.seq, partial);
        const record = {
            type: "line" as const,
            seq: this.seq,
            out: outStream,
            level: inferLineLevel(outStream, plain),
            ts: Date.now(),
            text: plain,
            raw: partial,
        };
        this.jsonlWriter.append(record);
        this.appendPlainMirror(outStream, record.text);
    }

    private appendUiLine(seq: number, raw: string): void {
        if (!this.uiJsonlWriter) {
            return;
        }

        this.uiJsonlWriter.append({
            type: "line",
            seq,
            text: raw,
        });
    }

    private appendPlainMirror(out: StreamOut, text: string): void {
        if (this.mode === "pty") {
            appendFileSync(this.opts.stdoutPath, `${text}\n`);
            return;
        }

        const path = out === "stdout" ? this.opts.stdoutPath : this.opts.stderrPath;
        appendFileSync(path, `${text}\n`);
    }
}
