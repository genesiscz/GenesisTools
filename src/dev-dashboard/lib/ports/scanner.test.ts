import { describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listListeningPorts } from "./scanner";

describe.skipIf(process.platform !== "darwin")("listListeningPorts on a live listener", () => {
    test("lists our IPv4 and IPv6 sockets on one port with the command, argv and cwd of the process", async () => {
        const marker = `gt-ports-probe-${crypto.randomUUID()}`;
        const dir = realpathSync(mkdtempSync(join(tmpdir(), "ports-probe-")));
        const code = `const net = require("node:net"); const a = net.createServer().listen(0, "127.0.0.1", () => { const port = a.address().port; net.createServer().listen(port, "::1", () => console.log(port)); });`;
        const child = Bun.spawn([process.execPath, "-e", code, marker], {
            cwd: dir,
            env: process.env,
            stdin: "ignore",
            stdout: "pipe",
            stderr: "ignore",
        });
        const { value } = await child.stdout.getReader().read();
        const port = Number(new TextDecoder().decode(value).trim());

        try {
            const spawn = spyOn(Bun, "spawn");
            let result: Awaited<ReturnType<typeof listListeningPorts>>;
            let spawned: string[] = [];

            try {
                result = await listListeningPorts();
                spawned = spawn.mock.calls.map((call) => (Array.isArray(call[0]) ? String(call[0][0]) : "?"));
            } finally {
                spawn.mockRestore();
            }

            const ours = result.ports.filter((entry) => entry.pid === child.pid);

            // The listeners and their working directories come from libproc; only the argv batch still runs ps.
            expect(spawned.filter((command) => command.endsWith("lsof"))).toEqual([]);
            expect(result.lsofAvailable).toBe(true);
            expect(ours.map((entry) => [entry.port, entry.proto, entry.address])).toEqual([
                [port, "tcp4", "127.0.0.1"],
                [port, "tcp6", "[::1]"],
            ]);

            for (const entry of ours) {
                expect(entry.fullCommand).toContain(marker);
                expect(entry.cwd).toBe(dir);
            }
        } finally {
            child.kill();
            await child.exited;
        }
    });
});
