import { describe, expect, test } from "bun:test";
import { extractBunModules } from "./bun-binary";

const TRAILER = new TextEncoder().encode("\n---- Bun! ----\n");

interface FixtureModule {
    name: string;
    contents: string;
    loader: number;
}

function u32(v: number): Uint8Array {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, v, true);
    return b;
}

function u64(v: number): Uint8Array {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setBigUint64(0, BigInt(v), true);
    return b;
}

function cat(...parts: Uint8Array[]): Uint8Array {
    const total = parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(total);
    let off = 0;

    for (const p of parts) {
        out.set(p, off);
        off += p.length;
    }

    return out;
}

/** Builds [junk+decoy][data][OFFSETS][TRAILER] like a real Bun binary's __bun section. */
function buildFixture(modules: FixtureModule[], entryPointId: number): Uint8Array {
    const enc = new TextEncoder();
    const strings: Uint8Array[] = [];
    const pointers: Array<{ nameOff: number; nameLen: number; cOff: number; cLen: number }> = [];
    let dataLen = 0;

    for (const m of modules) {
        const nameBytes = enc.encode(m.name);
        const contentBytes = enc.encode(m.contents);
        pointers.push({
            nameOff: dataLen,
            nameLen: nameBytes.length,
            cOff: dataLen + nameBytes.length,
            cLen: contentBytes.length,
        });
        strings.push(nameBytes, contentBytes);
        dataLen += nameBytes.length + contentBytes.length;
    }

    const STRIDE = 52;
    const table = new Uint8Array(STRIDE * modules.length);

    for (let i = 0; i < modules.length; i++) {
        const p = pointers[i];
        const m = modules[i];

        if (!p || !m) {
            throw new Error("fixture invariant");
        }

        table.set(u32(p.nameOff), i * STRIDE);
        table.set(u32(p.nameLen), i * STRIDE + 4);
        table.set(u32(p.cOff), i * STRIDE + 8);
        table.set(u32(p.cLen), i * STRIDE + 12);
        table[i * STRIDE + 48] = 1;
        table[i * STRIDE + 49] = m.loader;
        table[i * STRIDE + 50] = 2;
        table[i * STRIDE + 51] = 0;
    }

    const modulesOff = dataLen;
    const data = cat(...strings, table);
    const byteCount = data.length;
    const offsets = cat(
        u64(byteCount),
        u32(modulesOff),
        u32(STRIDE * modules.length),
        u32(entryPointId),
        u32(0),
        u32(0),
        u32(0)
    );
    const junk = cat(
        new TextEncoder().encode("MACH-O-RUNTIME-JUNK "),
        TRAILER,
        new TextEncoder().encode(" more junk between decoy and blob")
    );
    return cat(junk, data, offsets, TRAILER);
}

describe("extractBunModules", () => {
    test("parses modules and flags the entrypoint, skipping the decoy trailer", () => {
        const fixture = buildFixture(
            [
                { name: "/$bunfs/root/src/entrypoints/cli.js", contents: "// @bun\nconsole.log(1)", loader: 1 },
                { name: "/$bunfs/root/extra.node", contents: "\x00\x01binary", loader: 10 },
            ],
            0
        );
        const modules = extractBunModules(fixture);
        expect(modules.length).toBe(2);
        expect(modules[0]?.name).toBe("/$bunfs/root/src/entrypoints/cli.js");
        expect(modules[0]?.isEntrypoint).toBe(true);
        expect(new TextDecoder().decode(modules[0]?.contents)).toContain("console.log(1)");
        expect(modules[1]?.loader).toBe(10);
        expect(modules[1]?.isEntrypoint).toBe(false);
    });

    test("throws a diagnosable error when no trailer exists", () => {
        expect(() => extractBunModules(new Uint8Array(64))).toThrow(/Bun trailer/);
    });
});
