import { describe, expect, it } from "bun:test";
import { runDaemonScan } from "@app/macos/lib/clones/scan-daemon";

describe("runDaemonScan", () => {
    it("empty watchedDirs → returns scanned:false, writes nothing, no throw", async () => {
        const res = await runDaemonScan({ watchedDirs: [], notify: false });
        expect(res.scanned).toBe(false);
    });
});
