import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { untarGz } from "./untar";

async function makeTgz(): Promise<Uint8Array> {
    const dir = mkdtempSync(join(tmpdir(), "untar-test-"));
    writeFileSync(join(dir, "hello.txt"), "hello world");
    writeFileSync(join(dir, "big.bin"), new Uint8Array(1500).fill(7));
    const proc = Bun.spawn(["tar", "czf", "-", "-C", dir, "hello.txt", "big.bin"], { stdout: "pipe" });
    return new Uint8Array(await new Response(proc.stdout).arrayBuffer());
}

describe("untarGz", () => {
    test("extracts entries with correct bytes", async () => {
        const entries = untarGz(await makeTgz());
        expect(new TextDecoder().decode(entries.get("hello.txt"))).toBe("hello world");
        expect(entries.get("big.bin")?.length).toBe(1500);
        expect(entries.get("big.bin")?.[0]).toBe(7);
    });

    test("rejects path traversal", () => {
        const block = new Uint8Array(1024);
        const name = "../evil.txt";

        for (let i = 0; i < name.length; i++) {
            block[i] = name.charCodeAt(i);
        }

        const size = "00000000000";

        for (let i = 0; i < size.length; i++) {
            block[124 + i] = size.charCodeAt(i);
        }

        block[156] = 48;
        const gz = Bun.gzipSync(block);
        expect(() => untarGz(gz)).toThrow(/traversal/);
    });
});
