import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { skip } from "@app/utils/test/skip";
import { getPrivateSize } from "@app/utils/macos/apfs";

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
            spawnSync("dd", [
                "if=/dev/zero",
                `of=${dst}`,
                "bs=1",
                "count=4096",
                "seek=1048576",
                "conv=notrunc",
            ]);
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
