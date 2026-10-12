import { describe, expect, it } from "bun:test";
import { userInfo } from "node:os";
import { getListeningPorts, isLikelyDevProcess, parseLsofOutput, summarizeCommand } from "../lib/scanner";

describe("parseLsofOutput", () => {
    it("deduplicates by pid and keeps the highest-priority state", () => {
        const output = [
            "COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME",
            "node 123 alice 21u IPv4 0t0 TCP *:3000 (ESTABLISHED)",
            "node 123 alice 22u IPv4 0t0 TCP *:3000 (LISTEN)",
            "bun 456 bob 12u IPv4 0t0 TCP *:3001 (LISTEN)",
        ].join("\n");

        const processes = parseLsofOutput(output, -1);

        expect(processes).toHaveLength(2);
        expect(processes[0]).toMatchObject({ pid: 123, state: "LISTEN" });
        expect(processes[1]).toMatchObject({ pid: 456, state: "LISTEN" });
    });
});

describe("summarizeCommand", () => {
    it("prefers meaningful script fragments over the executable name", () => {
        const summary = summarizeCommand("node /Users/test/app/server.js --port 3000", "node");

        expect(summary).toBe("server.js 3000");
    });

    it("falls back to the process name when nothing useful is present", () => {
        expect(summarizeCommand("node --watch --inspect", "node")).toBe("node");
    });
});

describe("isLikelyDevProcess", () => {
    it("recognizes common dev runtimes", () => {
        expect(isLikelyDevProcess("node", "node server.js")).toBeTrue();
        expect(isLikelyDevProcess("python3", "python3 manage.py runserver")).toBeTrue();
    });

    it("filters out common desktop apps", () => {
        expect(isLikelyDevProcess("Spotify Helper", "Spotify Helper")).toBeFalse();
    });
});

/** A bun child of ours that listens and prints its port: on 127.0.0.1 and [::1] (one port), or on `::`. */
async function startListener(kind: "loopback-both" | "any-ipv6"): Promise<{ child: Bun.Subprocess; port: number }> {
    const code =
        kind === "loopback-both"
            ? `const net = require("node:net"); const a = net.createServer().listen(0, "127.0.0.1", () => { const port = a.address().port; net.createServer().listen(port, "::1", () => console.log(port)); });`
            : `const net = require("node:net"); const s = net.createServer().listen(0, "::", () => console.log(s.address().port));`;
    const child = Bun.spawn([process.execPath, "-e", code], {
        env: process.env,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "ignore",
    });
    const { value } = await child.stdout.getReader().read();
    return { child, port: Number(new TextDecoder().decode(value).trim()) };
}

describe.skipIf(process.platform !== "darwin")("getListeningPorts on live listeners", () => {
    it("lists each of our listeners once per pid with the cells lsof prints, and not one that exited", async () => {
        const both = await startListener("loopback-both");
        const any = await startListener("any-ipv6");
        const gone = await startListener("any-ipv6");
        gone.child.kill();
        await gone.child.exited;

        try {
            const pids = [both.child.pid, any.child.pid];
            const lsof = Bun.spawnSync(["lsof", "-nP", "-iTCP", "-sTCP:LISTEN", "-a", "-p", pids.join(",")], {
                env: process.env,
            });
            const expected = parseLsofOutput(lsof.stdout.toString(), -1);
            const ours = getListeningPorts().filter(
                (entry) => pids.includes(entry.pid) || entry.pid === gone.child.pid
            );
            const cells = (entry: { pid: number; user: string; state: string; name: string; fd: string }) => ({
                pid: entry.pid,
                user: entry.user,
                state: entry.state,
                name: entry.name,
                fd: entry.fd,
            });

            const byPid = (a: { pid: number }, b: { pid: number }) => a.pid - b.pid;

            expect(ours.map(cells).sort(byPid)).toEqual(expected.map(cells).sort(byPid));
            expect(ours.map((entry) => entry.port).sort()).toEqual([both.port, any.port].sort());
            expect(["127.0.0.1", "[::1]"].map((address) => `${address}:${both.port} (LISTEN)`)).toContain(
                ours.find((entry) => entry.pid === both.child.pid)?.name ?? ""
            );
            expect(ours.find((entry) => entry.pid === any.child.pid)?.name).toBe(`*:${any.port} (LISTEN)`);
            expect(ours.every((entry) => /^\d+u$/.test(entry.fd) && entry.user === userInfo().username)).toBe(true);
            expect(ours.every((entry) => entry.processName === "bun")).toBe(true);
        } finally {
            both.child.kill();
            any.child.kill();
            await Promise.all([both.child.exited, any.child.exited]);
        }
    });
});
