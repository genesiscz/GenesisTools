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
    // payload truncated through a pipe. It was dropped because a bare script
    // delivers all 300001 bytes on bun 1.3.14, but the truncation is NOT gone.
    // It returns as soon as anything in the import graph pulls in `node:process`,
    // which `@genesiscz/utils/logger` does transitively, so every tool in this
    // repo still loses everything past 65536 bytes if it uses `console.log`
    // (measured 2026-09-02). Command output belongs in writeStdout/printLn,
    // whose guarantee the test above pins.
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
