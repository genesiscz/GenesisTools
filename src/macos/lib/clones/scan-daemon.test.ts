import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatScanReport, reclaimableByRoot, runDaemonScan } from "@app/macos/lib/clones/scan-daemon";

describe("runDaemonScan", () => {
    it("empty watchedDirs → returns scanned:false, writes nothing, no throw", async () => {
        const res = await runDaemonScan({ watchedDirs: [], notify: false });
        expect(res.scanned).toBe(false);
        expect(formatScanReport(res)[0]).toContain("no watched folders are configured");
    });

    it("reports per watched folder what is reclaimable, the plan it wrote and the time", async () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-cl-scan-report-"));
        try {
            const work = join(dir, "work");
            const shop = join(dir, "shop");
            mkdirSync(work);
            mkdirSync(shop);
            writeFileSync(join(work, "model.bin"), Buffer.alloc(64_000, 7));
            writeFileSync(join(shop, "model.bin"), Buffer.alloc(64_000, 7));

            const res = await runDaemonScan({ watchedDirs: [work, shop], notify: false, minReal: 4096 });

            expect(res.scanned).toBe(true);
            expect(res.sets).toBe(1);
            expect(res.reclaimable).toBe(64_000);
            expect(res.planKey).toBeTruthy();
            // The kept copy is the first by path (shop/…), so the copy in work/ is the one that would be replaced.
            expect(res.roots).toEqual([
                { root: work, reclaimable: 64_000, sets: 1 },
                { root: shop, reclaimable: 0, sets: 0 },
            ]);
            const report = formatScanReport(res).join("\n");
            expect(report).toContain("2 watched folders");
            expect(report).toContain(`${work}: 62.5 KB reclaimable in 1 duplicate set`);
            expect(report).toContain(`${shop}: nothing reclaimable`);
            expect(report).toContain("total: 62.5 KB reclaimable in 1 duplicate set");
            expect(report).toContain(`plan written: dry-run plan snapshot ${res.planKey}`);
            expect(report).toMatch(/time: /);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe("reclaimableByRoot", () => {
    it("counts each replaced copy for the folder it sits in, and never the kept copy", () => {
        const roots = ["/w/a", "/w/b", "/w/a/deep"];
        const rows = reclaimableByRoot(
            [
                {
                    kind: "file",
                    what: "x",
                    copies: 3,
                    eachBytes: 10,
                    reclaimable: 20,
                    keep: "/w/a/x",
                    members: ["/w/a/x", "/w/b/x", "/w/a/deep/x"],
                },
            ],
            roots
        );

        expect(rows).toEqual([
            { root: "/w/a", reclaimable: 0, sets: 0 },
            { root: "/w/b", reclaimable: 10, sets: 1 },
            { root: "/w/a/deep", reclaimable: 10, sets: 1 },
        ]);
    });
});
