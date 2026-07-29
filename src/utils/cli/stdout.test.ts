import { describe, expect, it, spyOn } from "bun:test";
import { join } from "node:path";
import { skip } from "@genesiscz/utils/test/skip";
import { printLn } from "./stdout";

const FIXTURE = join(import.meta.dir, "__fixtures__/stdout-fixture.ts");

describe.skipIf(skip.onWindows)("writeStdout", () => {
    it("delivers a large payload intact through a slow pipe consumer", async () => {
        const proc = Bun.spawn(["sh", "-c", `bun run '${FIXTURE}' 300000 | cat`], {
            stdout: "pipe",
            stderr: "pipe",
        });
        const out = await new Response(proc.stdout).text();
        await proc.exited;
        expect(out.length).toBe(300001);
    });

    // A second test used to pin the MOTIVATION: plain `console.log` of the same
    // payload truncated through a pipe. Bun fixed that truncation (observed
    // delivering all 300001 bytes on 1.3.14), so asserting the bug's presence
    // failed on every current runtime. writeStdout keeps its guarantee either
    // way, which the test above pins; the historical bug does not need to
    // stay reproducible for that to hold.
});

describe("printLn", () => {
    it("writes the text with a trailing newline", async () => {
        let output = "";
        const stdoutSpy = spyOn(process.stdout, "write").mockImplementation(
            (
                chunk: string | Uint8Array,
                encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
                callback?: (error?: Error | null) => void
            ) => {
                output += String(chunk);
                const cb = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
                cb?.();
                return true;
            }
        );

        try {
            await printLn("hello");
        } finally {
            stdoutSpy.mockRestore();
        }

        expect(output).toBe("hello\n");
    });

    it("joins an array of strings with newlines", async () => {
        let output = "";
        const stdoutSpy = spyOn(process.stdout, "write").mockImplementation(
            (
                chunk: string | Uint8Array,
                encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
                callback?: (error?: Error | null) => void
            ) => {
                output += String(chunk);
                const cb = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
                cb?.();
                return true;
            }
        );

        try {
            await printLn(["hello", "world"]);
        } finally {
            stdoutSpy.mockRestore();
        }

        expect(output).toBe("hello\nworld\n");
    });
});
