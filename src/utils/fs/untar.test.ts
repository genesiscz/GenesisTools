import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { untarGz } from "./untar";

async function makeTgz(): Promise<Uint8Array> {
    const dir = mkdtempSync(join(tmpdir(), "untar-test-"));
    writeFileSync(join(dir, "hello.txt"), "hello world");
    writeFileSync(join(dir, "big.bin"), new Uint8Array(1500).fill(7));
    const proc = Bun.spawn(["tar", "czf", "-", "-C", dir, "hello.txt", "big.bin"], {
        stdout: "pipe",
        stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).arrayBuffer(),
        new Response(proc.stderr).text(),
        proc.exited,
    ]);

    if (exitCode !== 0) {
        throw new Error(`tar failed with exit code ${exitCode}: ${stderr}`);
    }

    return new Uint8Array(stdout);
}

function buildRawEntry(name: string): Uint8Array {
    const block = new Uint8Array(1024);

    for (let i = 0; i < name.length; i++) {
        block[i] = name.charCodeAt(i);
    }

    const size = "00000000000";

    for (let i = 0; i < size.length; i++) {
        block[124 + i] = size.charCodeAt(i);
    }

    block[156] = 48;
    return Bun.gzipSync(block);
}

describe("untarGz", () => {
    test("extracts entries with correct bytes", async () => {
        const entries = untarGz(await makeTgz());
        expect(new TextDecoder().decode(entries.get("hello.txt"))).toBe("hello world");
        expect(entries.get("big.bin")?.length).toBe(1500);
        expect(entries.get("big.bin")?.[0]).toBe(7);
    });

    test("rejects path traversal", () => {
        expect(() => untarGz(buildRawEntry("../evil.txt"))).toThrow(/traversal/);
    });

    test("rejects Windows-style traversal and absolute/drive paths", () => {
        expect(() => untarGz(buildRawEntry("..\\evil.txt"))).toThrow(/traversal/);
        expect(() => untarGz(buildRawEntry("/etc/passwd"))).toThrow(/traversal/);
        expect(() => untarGz(buildRawEntry("C:\\evil.txt"))).toThrow(/traversal/);
    });

    test("rejects a malformed (non-octal) size field", () => {
        const block = new Uint8Array(1024);
        const name = "bad.txt";

        for (let i = 0; i < name.length; i++) {
            block[i] = name.charCodeAt(i);
        }

        const size = "0000000zz00";

        for (let i = 0; i < size.length; i++) {
            block[124 + i] = size.charCodeAt(i);
        }

        block[156] = 48;
        expect(() => untarGz(Bun.gzipSync(block))).toThrow(/invalid size field/);
    });

    test("rejects a truncated entry even when it would be skipped", () => {
        const block = new Uint8Array(512);
        const name = "gone/";

        for (let i = 0; i < name.length; i++) {
            block[i] = name.charCodeAt(i);
        }

        const size = "00000001750";

        for (let i = 0; i < size.length; i++) {
            block[124 + i] = size.charCodeAt(i);
        }

        block[156] = 53;
        expect(() => untarGz(Bun.gzipSync(block))).toThrow(/truncated/);
    });
});
