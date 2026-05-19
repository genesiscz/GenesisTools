import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getPrivateSize } from "@app/utils/macos/apfs";
import { skip } from "@app/utils/test/skip";

describe.skipIf(skip.unlessMac)("apfs getPrivateSize (clone semantics)", () => {
    it("reports ~0 for a fresh clone, then rises as it diverges", () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-apfs-"));
        const src = join(dir, "src.bin");
        const dst = join(dir, "dst.bin");
        try {
            // 8 MB unique file
            const buf = Buffer.alloc(8 * 1024 * 1024);
            for (let i = 0; i < buf.length; i += 4096) {
                buf.writeUInt32LE((Math.random() * 0xffffffff) >>> 0, i);
            }

            writeFileSync(src, buf);

            // APFS clone (cp -c forces clonefile)
            expect(spawnSync("cp", ["-c", src, dst]).status).toBe(0);

            const clonedPrivate = getPrivateSize(dst);
            expect(clonedPrivate).not.toBeNull();
            // fully shared → near-zero private bytes
            expect(clonedPrivate as number).toBeLessThan(256 * 1024);

            // modify one block of dst → that block goes private (COW)
            spawnSync("dd", ["if=/dev/zero", `of=${dst}`, "bs=1", "count=4096", "seek=1048576", "conv=notrunc"]);
            const modifiedPrivate = getPrivateSize(dst) as number;
            expect(modifiedPrivate).toBeGreaterThan(clonedPrivate as number);

            // delete src → dst is now sole owner → private ≈ full size
            rmSync(src);
            const soloPrivate = getPrivateSize(dst) as number;
            expect(soloPrivate).toBeGreaterThan(7 * 1024 * 1024);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

import { getCloneId, getExtFlags, isApfsCloneSupported } from "@app/utils/macos/apfs";

describe.skipIf(skip.unlessMac)("apfs clone identity", () => {
    it("two clones share a non-zero clone id; ext flags mark sharing", () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-apfs-id-"));
        const src = join(dir, "a.bin");
        const dst = join(dir, "b.bin");
        try {
            writeFileSync(src, Buffer.alloc(1024 * 1024, 7));
            expect(spawnSync("cp", ["-c", src, dst]).status).toBe(0);

            const idSrc = getCloneId(src);
            const idDst = getCloneId(dst);
            expect(idSrc).not.toBeNull();
            expect(idSrc).not.toBe(0n);
            expect(idDst).toBe(idSrc);

            const flags = getExtFlags(dst);
            expect(flags).not.toBeNull();
            expect((flags as { mayShareBlocks: boolean }).mayShareBlocks).toBe(true);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("isApfsCloneSupported is true on macOS", () => {
        expect(isApfsCloneSupported()).toBe(true);
    });
});

import { lstatSync, mkdtempSync as mkd2, readFileSync } from "node:fs";
import { CloneUnsupportedError, cloneFile, getFsType } from "@app/utils/macos/apfs";

describe.skipIf(skip.unlessMac)("apfs cloneFile + getFsType", () => {
    it("getFsType returns 'apfs' for the system volume", () => {
        expect(getFsType("/")).toBe("apfs");
    });

    it("cloneFile makes an independent COW copy (mutating one never touches the other)", () => {
        const dir = mkd2(join(tmpdir(), "gt-clonefile-"));
        const a = join(dir, "a.bin");
        const b = join(dir, "b.bin");
        try {
            writeFileSync(a, Buffer.alloc(1024 * 1024, 0x5a));
            cloneFile(a, b);

            expect(lstatSync(a).ino).not.toBe(lstatSync(b).ino); // different inodes
            expect(getCloneId(a)).toBe(getCloneId(b)); // same clone family
            expect(readFileSync(b).equals(readFileSync(a))).toBe(true);

            // mutate b → a must be unchanged (COW independence)
            writeFileSync(b, Buffer.alloc(1024 * 1024, 0x01));
            expect(readFileSync(a)[0]).toBe(0x5a);
            // mutate a → b must be unchanged
            writeFileSync(a, Buffer.alloc(1024 * 1024, 0x02));
            expect(readFileSync(b)[0]).toBe(0x01);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("CloneUnsupportedError is a typed Error", () => {
        const e = new CloneUnsupportedError("nope");
        expect(e).toBeInstanceOf(Error);
        expect(e.name).toBe("CloneUnsupportedError");
    });
});
