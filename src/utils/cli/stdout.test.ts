import { describe, expect, it, spyOn } from "bun:test";
import { join } from "node:path";
import { skip } from "@app/utils/test/skip";
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

    it("plain console.log truncates the same payload", async () => {
        const proc = Bun.spawn(["sh", "-c", `bun -e 'console.log("X".repeat(300000))' | cat`], {
            stdout: "pipe",
        });
        const out = await new Response(proc.stdout).text();
        await proc.exited;
        expect(out.length).toBeLessThan(300001);
    });
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
