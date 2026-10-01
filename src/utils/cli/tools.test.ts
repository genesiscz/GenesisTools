import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isProcessAlive } from "@genesiscz/utils/process-alive";
import { collectOutput } from "./tools";

async function until(check: () => boolean, deadlineMs: number): Promise<boolean> {
    const end = Date.now() + deadlineMs;

    while (Date.now() < end) {
        if (check()) {
            return true;
        }

        await Bun.sleep(Math.min(25, end - Date.now()));
    }

    return check();
}

describe.skipIf(process.platform === "win32")("collectOutput with a process group", () => {
    test("the deadline's SIGKILL reaches a group member that outlived its leader", async () => {
        const pidFile = join(mkdtempSync(join(tmpdir(), "collect-output-")), "member.pid");
        // The leader dies on SIGTERM. Its child ignores SIGTERM, writes its pid, and holds the pipes.
        const proc = Bun.spawn(
            ["/bin/sh", "-c", `sh -c 'trap "" TERM; echo $$ > "$0"; exec sleep 30' '${pidFile}' & wait`],
            { stdin: "ignore", stdout: "pipe", stderr: "pipe", detached: true, env: process.env }
        );
        // The trap is set before the pid is written, so the SIGTERM below cannot beat it.
        expect(await until(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").endsWith("\n"), 5000)).toBe(true);
        const member = Number(readFileSync(pidFile, "utf8"));

        const result = await collectOutput(proc, 100, { group: true, graceMs: 200 });

        expect(result).toMatchObject({ exitCode: 124, timedOut: true });
        expect(proc.signalCode).toBe("SIGTERM");
        expect(await until(() => !isProcessAlive(member), 2000)).toBe(true);
    });

    test("the deadline reaches a group member when the leader exited before it", async () => {
        const pidFile = join(mkdtempSync(join(tmpdir(), "collect-output-")), "member.pid");
        // The leader starts a member that holds the pipes, writes the member's pid, and exits at once.
        const proc = Bun.spawn(["/bin/sh", "-c", `sleep 30 & echo $! > '${pidFile}'`], {
            stdin: "ignore",
            stdout: "pipe",
            stderr: "pipe",
            detached: true,
            env: process.env,
        });
        expect(await until(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").endsWith("\n"), 5000)).toBe(true);
        const member = Number(readFileSync(pidFile, "utf8"));
        await proc.exited;

        const result = await collectOutput(proc, 100, { group: true, graceMs: 200 });

        expect(result).toMatchObject({ exitCode: 124, timedOut: true });
        expect(await until(() => !isProcessAlive(member), 2000)).toBe(true);
    });
});

describe.skipIf(process.platform === "win32")("collectOutput bounds", () => {
    test("maxBytes keeps that many bytes, stops the child and says truncated", async () => {
        const proc = Bun.spawn(["/bin/sh", "-c", "yes 0123456789"], {
            env: process.env,
            stdin: "ignore",
            stdout: "pipe",
            stderr: "pipe",
        });

        const result = await collectOutput(proc, 5000, { maxBytes: 1000 });

        expect(result.truncated).toBe(true);
        expect(result.stdout.length).toBe(1000);
    });

    test("an aborted signal ends the child like the deadline", async () => {
        const proc = Bun.spawn(["/bin/sh", "-c", "exec sleep 30"], {
            stdin: "ignore",
            stdout: "pipe",
            stderr: "pipe",
            env: process.env,
        });
        const controller = new AbortController();
        setTimeout(() => controller.abort(), 50);

        const result = await collectOutput(proc, undefined, { signal: controller.signal, graceMs: 200 });

        expect(result).toMatchObject({ exitCode: 124, timedOut: true });
    });
});
