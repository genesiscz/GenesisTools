import { describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listListeningPorts, parseLsofListen } from "./scanner";

const FIXTURE = [
    "COMMAND     PID   USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME",
    "rapportd    711 Martin   10u  IPv4 0x8b160b4fe7f3824d      0t0  TCP *:53357 (LISTEN)",
    "rapportd    711 Martin   11u  IPv6 0x84a01adc303d0215      0t0  TCP *:53357 (LISTEN)",
    "node       1307 Martin   18u  IPv4 0xa4528e4de8db5a64      0t0  TCP 127.0.0.1:18789 (LISTEN)",
    "node       1307 Martin   19u  IPv6 0x3486ea0eed65f93d      0t0  TCP [::1]:18789 (LISTEN)",
    "bun        1321 Martin    7u  IPv4 0xf7ff0254c4e99697      0t0  TCP 127.0.0.1:3074 (LISTEN)",
    "php-fpm    1331 Martin    9u  IPv4 0x571546a4f62a8e3b      0t0  TCP 127.0.0.1:9000 (LISTEN)",
    "",
].join("\n");

describe("parseLsofListen", () => {
    test("parses ports across IPv4/IPv6 and multiple PIDs, sorted by port", () => {
        const result = parseLsofListen(FIXTURE);

        // 7 LISTEN rows → 6 entries after deduping (rapportd :53357 v4+v6 share pid+port → kept as
        // two distinct proto rows; node :18789 v4+v6 → two distinct proto rows). Dedup is per
        // (pid, port, proto): no exact duplicate in the fixture, so all 6 unique rows survive,
        // sorted ascending by port.
        expect(result.map((p) => p.port)).toEqual([3074, 9000, 18789, 18789, 53357, 53357]);
    });

    test("extracts pid, command (truncated ok), address and proto", () => {
        const result = parseLsofListen(FIXTURE);
        const bun = result.find((p) => p.port === 3074);
        expect(bun).toEqual({ port: 3074, pid: 1321, command: "bun", address: "127.0.0.1", proto: "tcp4" });

        const phpFpm = result.find((p) => p.port === 9000);
        expect(phpFpm?.command).toBe("php-fpm");

        const node6 = result.find((p) => p.port === 18789 && p.proto === "tcp6");
        expect(node6?.address).toBe("[::1]");
    });

    test("dedupes an exact (pid, port, proto) repeat", () => {
        const dup = [
            "node       1307 Martin   18u  IPv4 0xaaaa      0t0  TCP 127.0.0.1:18789 (LISTEN)",
            "node       1307 Martin   20u  IPv4 0xbbbb      0t0  TCP 127.0.0.1:18789 (LISTEN)",
        ].join("\n");
        expect(parseLsofListen(dup)).toHaveLength(1);
    });

    test("skips the header and blank lines; empty input → []", () => {
        expect(parseLsofListen("")).toEqual([]);
        expect(parseLsofListen("COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME\n")).toEqual([]);
    });
});

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
