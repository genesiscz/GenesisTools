import { describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearPortFile, readPortFile, writePortFile } from "@app/youtube/lib/server/port-file";

describe("server port file", () => {
    it("writes, reads, and clears a discovered server port", async () => {
        const dir = await mkdtemp(join(tmpdir(), "youtube-server-port-"));
        const portFile = join(dir, "port");

        try {
            expect(readPortFile({ portFile })).toBeNull();

            writePortFile({ port: 43210, portFile });

            expect(readPortFile({ portFile })).toBe(43210);

            clearPortFile({ portFile });

            expect(readPortFile({ portFile })).toBeNull();
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    it("returns null for invalid port file contents", async () => {
        const dir = await mkdtemp(join(tmpdir(), "youtube-server-port-"));
        const portFile = join(dir, "port");

        try {
            await Bun.write(portFile, "not-a-port");

            expect(readPortFile({ portFile })).toBeNull();
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });
});
