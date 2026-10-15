import { describe, expect, it } from "bun:test";
import {
    closeSync,
    ftruncateSync,
    mkdirSync,
    mkdtempSync,
    openSync,
    readFileSync,
    realpathSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DiskSpaceAnalyzer, isFdAvailable, parseTmutilOutput } from "@app/doctor/analyzers/disk-space";

const FIXTURES = join(import.meta.dir, "fixtures");

describe("parseTmutilOutput", () => {
    it("returns empty array for empty snapshot list", () => {
        const raw = readFileSync(join(FIXTURES, "tmutil-empty.txt"), "utf8");
        expect(parseTmutilOutput(raw)).toEqual([]);
    });

    it("parses snapshot names", () => {
        const raw = readFileSync(join(FIXTURES, "tmutil-with-snapshots.txt"), "utf8");
        const snapshots = parseTmutilOutput(raw);
        expect(snapshots).toHaveLength(3);
        expect(snapshots[0]).toBe("com.apple.TimeMachine.2026-04-15-080000.local");
    });
});

describe("isFdAvailable", () => {
    it("returns boolean", async () => {
        expect(typeof (await isFdAvailable())).toBe("boolean");
    });
});

describe("large files: allocated size and the VM deny list", () => {
    it("never offers a sparse file or a VM disk for removal, and still offers a plain file", async () => {
        const root = realpathSync(mkdtempSync(join(tmpdir(), "doctor-large-")));

        try {
            const sparsePath = join(root, "vm-disk.img");
            const fd = openSync(sparsePath, "w");
            ftruncateSync(fd, 2 * 1024 * 1024 * 1024);
            closeSync(fd);
            const dockerRaw = join(
                root,
                "Library",
                "Containers",
                "com.docker.docker",
                "Data",
                "vms",
                "0",
                "data",
                "Docker.raw"
            );
            mkdirSync(join(dockerRaw, ".."), { recursive: true });
            writeFileSync(dockerRaw, Buffer.alloc(2 * 1024 * 1024, 1));
            const plain = join(root, "export.mov");
            writeFileSync(plain, Buffer.alloc(2 * 1024 * 1024, 1));

            const analyzer = new DiskSpaceAnalyzer({ home: root });
            const findings = await analyzer.findAdhoc({ root, minMB: 1, maxDays: 30 });
            const byPath = new Map(findings.map((f) => [f.metadata?.path, f]));

            for (const path of [sparsePath, dockerRaw]) {
                const finding = byPath.get(path);
                expect(finding?.severity).toBe("blocked");
                expect(finding?.actions).toEqual([]);
                expect(finding?.reclaimableBytes).toBeUndefined();
                expect(finding?.blacklistReason).toBeTruthy();
            }

            expect(byPath.get(sparsePath)?.metadata?.apparentBytes).toBe(2 * 1024 * 1024 * 1024);
            expect(byPath.get(sparsePath)?.metadata?.allocatedBytes as number).toBeLessThan(64 * 1024 * 1024);
            expect(byPath.get(plain)?.severity).toBe("cautious");
            expect(byPath.get(plain)?.actions.map((a) => a.id)).toEqual(["stage-trash", "direct-delete", "reveal"]);
            expect(byPath.get(plain)?.metadata?.paths).toEqual([plain]);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
});
