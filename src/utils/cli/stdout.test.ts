import { describe, expect, it, spyOn } from "bun:test";
import { join } from "node:path";
import { skip } from "@genesiscz/utils/test/skip";
import { isBrokenPipe, printLn, writeStdout, writeStdoutStrict } from "./stdout";

const FIXTURE = join(import.meta.dir, "__fixtures__/stdout-fixture.ts");

describe.skipIf(skip.onWindows)("writeStdout", () => {
    it("delivers a large payload intact through a slow pipe consumer", async () => {
        const proc = Bun.spawn(["sh", "-c", `bun run '${FIXTURE}' 300000 | cat`], {
            env: process.env,
            stdout: "pipe",
            stderr: "pipe",
        });
        const out = await new Response(proc.stdout).text();
        await proc.exited;
        expect(out.length).toBe(300001);
    });

    it("exits quietly when a real pipe reader closes", async () => {
        const proc = Bun.spawn(["bash", "-o", "pipefail", "-c", 'bun run "$1" 300000 | head -c 1', "test", FIXTURE], {
            env: process.env,
            stdout: "pipe",
            stderr: "pipe",
        });
        const stderr = await new Response(proc.stderr).text();
        expect(await proc.exited).toBe(0);
        expect(stderr).toBe("");
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

describe("writeStdout on a closed pipe", () => {
    function failingWrite(code: string) {
        return spyOn(process.stdout, "write").mockImplementation(((
            _text: string,
            cb?: (error?: Error | null) => void
        ) => {
            cb?.(Object.assign(new Error(`${code}: write`), { code }));
            return false;
        }) as typeof process.stdout.write);
    }

    it("resolves when the reader went away (`… | head`), instead of crashing the tool", async () => {
        const spy = failingWrite("EPIPE");

        try {
            await expect(writeStdout("skeleton\n")).resolves.toBeUndefined();
        } finally {
            spy.mockRestore();
        }
    });

    it("identifies broken pipes without swallowing other errors", () => {
        expect(isBrokenPipe(Object.assign(new Error("closed"), { code: "EPIPE" }))).toBe(true);
        expect(isBrokenPipe(Object.assign(new Error("disk"), { code: "EIO" }))).toBe(false);
        expect(isBrokenPipe(null)).toBe(false);
    });

    it("reports a closed pipe to delivery-sensitive callers", async () => {
        const spy = failingWrite("EPIPE");
        try {
            await expect(writeStdoutStrict("event\n")).rejects.toMatchObject({ code: "EPIPE" });
        } finally {
            spy.mockRestore();
        }
    });

    it.each([
        ["callback-first", "EIO"],
        ["event-first", "EIO"],
        ["event-first", "EPIPE"],
    ])("routes the stream error (%s, %s)", async (order, code) => {
        const script = `
            import { writeStdoutStrict } from ${JSON.stringify(join(import.meta.dir, "stdout.ts"))};
            const failure = Object.assign(new Error("write failed"), { code: ${JSON.stringify(code)} });
            process.stdout.write = (_text, callback) => {
                if (${JSON.stringify(order)} === "callback-first") {
                    callback(failure);
                    process.nextTick(() => process.stdout.emit("error", failure));
                } else {
                    process.stdout.emit("error", failure);
                    callback(failure);
                }
                return false;
            };
            try {
                await writeStdoutStrict("event");
                process.exitCode = 2;
            } catch (error) {
                if (error !== failure) process.exitCode = 3;
            }
            await new Promise((resolve) => setTimeout(resolve, 10));
        `;
        const proc = Bun.spawn(["bun", "-e", script], { env: process.env, stdout: "pipe", stderr: "pipe" });
        const stderr = await new Response(proc.stderr).text();
        expect(await proc.exited).toBe(0);
        expect(stderr).toBe("");
    });

    it("still rejects any other write error", async () => {
        const spy = failingWrite("EIO");

        try {
            await expect(writeStdout("skeleton\n")).rejects.toThrow("EIO");
        } finally {
            spy.mockRestore();
        }
    });
});
