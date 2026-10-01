import { describe, expect, it } from "bun:test";
import { createServer, type Socket } from "node:net";
import { findLoopbackClientPids, readOpenFilePaths, readProcessInfo } from "./socket-owner";

describe.skipIf(process.platform !== "darwin")("socket-owner", () => {
    it("finds this process as the owner of its own client socket, and nobody for another server port", async () => {
        const accepted: Socket[] = [];
        const server = createServer((socket) => accepted.push(socket));
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address();
        if (!address || typeof address === "string") {
            throw new Error("no address");
        }

        const client = await new Promise<Socket>((resolve) => {
            const { connect } = require("node:net") as typeof import("node:net");
            const socket = connect(address.port, "127.0.0.1", () => resolve(socket));
        });

        try {
            const clientPort = client.localPort;
            if (clientPort === undefined) {
                throw new Error("no client port");
            }

            const started = performance.now();
            const owners = findLoopbackClientPids({ clientPort, serverPort: address.port });
            const ms = performance.now() - started;
            expect(owners).toEqual([process.pid]);
            expect(findLoopbackClientPids({ clientPort: clientPort, serverPort: address.port + 1 })).toEqual([]);
            expect(ms).toBeLessThan(2000);
        } finally {
            client.destroy();
            for (const socket of accepted) {
                socket.destroy();
            }

            server.close();
        }
    });

    it("lists a file this process holds open, and stops listing it after close", () => {
        const { closeSync, mkdtempSync, openSync, realpathSync } = require("node:fs") as typeof import("node:fs");
        const { tmpdir } = require("node:os") as typeof import("node:os");
        const path = `${realpathSync(mkdtempSync(`${tmpdir()}/open-files-`))}/rollout-invented.jsonl`;
        const fd = openSync(path, "a");
        try {
            expect(readOpenFilePaths(process.pid)).toContain(path);
        } finally {
            closeSync(fd);
        }

        expect(readOpenFilePaths(process.pid)).not.toContain(path);
    });

    it("reads its own name, uid and start time", () => {
        const info = readProcessInfo(process.pid);
        expect(info?.uid).toBe(process.getuid?.());
        expect(info?.name.length).toBeGreaterThan(0);
        expect(Math.abs((info?.startSec ?? 0) - (Date.now() / 1000 - process.uptime()))).toBeLessThan(5);
    });
});
