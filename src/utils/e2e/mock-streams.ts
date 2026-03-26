import { Readable, Writable } from "node:stream";

/**
 * Mock writable stream for unit-testing clack-based commands in-process.
 * Ported from @clack/prompts test infra (packages/core/test/mock-writable.ts).
 *
 * Captures all output to `.buffer` for assertions.
 * NOT usable in e2e tests (those spawn subprocesses via Bun.spawn).
 */
export class MockWritable extends Writable {
    public buffer: string[] = [];
    public isTTY = false;
    public columns = 80;
    public rows = 20;

    _write(chunk: unknown, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
        this.buffer.push(String(chunk));
        callback();
    }
}

/**
 * Mock readable stream for unit-testing clack-based commands in-process.
 * Ported from @clack/prompts test infra (packages/core/test/mock-readable.ts).
 *
 * Use `.pushValue()` to feed keypress data, `.close()` to end the stream.
 */
export class MockReadable extends Readable {
    protected _buffer: unknown[] | null = [];

    _read(): void {
        if (this._buffer === null) {
            this.push(null);
            return;
        }

        for (const val of this._buffer) {
            this.push(val);
        }

        this._buffer = [];
    }

    pushValue(val: unknown): void {
        this._buffer?.push(val);
    }

    close(): void {
        this._buffer = null;
    }
}
