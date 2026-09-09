import { expect, test } from "bun:test";
import { SafeJSON } from "@genesiscz/utils/json";
import { createTerminalShutdown } from "./terminal-shutdown";

test("termination closes the transport and unblocks an import before a TUI exists", async () => {
    let reject!: (error: Error) => void;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const pending = new Promise<void>((_resolve, fail) => {
        reject = fail;
        timer = setTimeout(() => fail(new Error("termination was ignored")), 100);
    });
    let closes = 0;
    const shutdown = createTerminalShutdown(
        {
            close: async () => {
                closes++;
                clearTimeout(timer);
                reject(new Error("native transport closed"));
            },
        },
        () => undefined
    );
    shutdown.terminate();
    await expect(pending).rejects.toThrow("native transport closed");
    await shutdown.close();
    expect(closes).toBe(1);
});

test("a running TUI owns interrupts while termination still reaches it", async () => {
    const signals: string[] = [];
    let closes = 0;
    const shutdown = createTerminalShutdown(
        {
            close: async () => {
                closes++;
            },
        },
        () => ({
            kill: (signal) => {
                signals.push(signal);
            },
        })
    );
    shutdown.interrupt();
    expect(closes).toBe(0);
    expect(signals).toEqual([]);
    shutdown.terminate();
    expect(signals).toEqual(["SIGTERM"]);
    await shutdown.close();
    expect(closes).toBe(1);
});

test.skipIf(process.platform === "win32")(
    "SIGTERM directed at a wrapper process interrupts its pending import",
    async () => {
        const script = `
        import { createTerminalShutdown } from ${SafeJSON.stringify(import.meta.resolve("./terminal-shutdown"))};
        let finish;
        const pending = new Promise(resolve => { finish = resolve; });
        const keepAlive = setInterval(() => {}, 1000);
        const shutdown = createTerminalShutdown({ close: async () => { clearInterval(keepAlive); finish(); } }, () => undefined);
        process.on("SIGTERM", shutdown.terminate);
        process.stdout.write("ready\\n");
        await pending;
        await shutdown.close();
        process.stdout.write("stopped\\n");
    `;
        const child = Bun.spawn([process.execPath, "--eval", script], {
            env: process.env,
            stdin: "ignore",
            stdout: "pipe",
            stderr: "pipe",
        });
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            const reader = child.stdout.getReader();
            const ready = await reader.read();
            expect(new TextDecoder().decode(ready.value)).toContain("ready");
            child.kill("SIGTERM");
            const exit = await Promise.race([
                child.exited,
                new Promise<string>((resolve) => {
                    timer = setTimeout(() => resolve("signal ignored"), 2000);
                }),
            ]);
            expect(exit).toBe(0);
            let output = "";
            for (;;) {
                const chunk = await reader.read();
                if (chunk.done) {
                    break;
                }
                output += new TextDecoder().decode(chunk.value);
            }
            reader.releaseLock();
            expect(output).toContain("stopped");
        } finally {
            clearTimeout(timer);
            child.kill("SIGKILL");
        }
    }
);
