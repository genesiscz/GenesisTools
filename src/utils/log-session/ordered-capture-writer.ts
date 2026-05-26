import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { stripAnsi } from "@app/utils/string";
import { inferLineLevel } from "./infer-line-level";
import { JsonlWriter } from "./jsonl-writer";
import type { StreamOut } from "./types";

export type CaptureMode = "pty" | "pipe";

export interface OrderedCaptureWriterOptions {
    jsonlPath: string;
    stdoutPath: string;
    stderrPath: string;
    mode: CaptureMode;
}

export class OrderedCaptureWriter {
    private readonly jsonlWriter: JsonlWriter;
    private readonly mode: CaptureMode;
    private queue: Array<{ out: StreamOut; chunk: string }> = [];
    private seq = 0;
    private draining = false;
    private stdoutPartial = "";
    private stderrPartial = "";

    constructor(private readonly opts: OrderedCaptureWriterOptions) {
        this.jsonlWriter = new JsonlWriter(opts.jsonlPath);
        this.mode = opts.mode;
        mkdirSync(dirname(opts.jsonlPath), { recursive: true });
        mkdirSync(dirname(opts.stdoutPath), { recursive: true });
        mkdirSync(dirname(opts.stderrPath), { recursive: true });
        if (!existsSync(opts.stdoutPath)) {
            writeFileSync(opts.stdoutPath, "");
        }

        if (!existsSync(opts.stderrPath)) {
            writeFileSync(opts.stderrPath, "");
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
                const record = {
                    type: "line" as const,
                    seq: this.seq,
                    out: outStream,
                    level: inferLineLevel(outStream, plain),
                    ts: Date.now(),
                    text: plain,
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

        return parts.filter((line) => line.length > 0 || parts.length > 1);
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
        const record = {
            type: "line" as const,
            seq: this.seq,
            out: outStream,
            level: inferLineLevel(outStream, plain),
            ts: Date.now(),
            text: plain,
        };
        this.jsonlWriter.append(record);
        this.appendPlainMirror(outStream, record.text);
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
