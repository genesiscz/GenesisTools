import { describe, expect, it } from "bun:test";
import { formatBytes, sumBytes } from "@app/doctor/lib/size";

describe("size", () => {
    it("formatBytes handles 0", () => {
        expect(formatBytes(0)).toBe("0 B");
    });

    it("formatBytes kb boundary", () => {
        expect(formatBytes(999)).toBe("999 B");
        expect(formatBytes(1000)).toBe("1.0 KB");
    });

    it("formatBytes uses decimal units like the Finder", () => {
        expect(formatBytes(1_000_000)).toBe("1.0 MB");
        expect(formatBytes(1_000_000_000)).toBe("1.0 GB");
        // The 600 MiB test file of 2026-10-14: the Finder and the Disk Manager both say 629 MB.
        expect(formatBytes(629_145_600)).toBe("629.1 MB");
    });

    it("formatBytes moves up a unit instead of printing 1000.0", () => {
        expect(formatBytes(999_960_000)).toBe("1.0 GB");
        expect(formatBytes(999_940_000)).toBe("999.9 MB");
    });

    it("formatBytes tb", () => {
        expect(formatBytes(1_000_000_000_000)).toBe("1.0 TB");
    });

    it("sumBytes totals an array of findings with reclaimableBytes", () => {
        expect(sumBytes([{ reclaimableBytes: 100 }, { reclaimableBytes: 200 }, {}])).toBe(300);
    });
});
