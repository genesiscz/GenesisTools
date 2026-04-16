import { describe, expect, it } from "bun:test";
import { formatBytes, sumBytes } from "@app/doctor/lib/size";

describe("size", () => {
    it("formatBytes handles 0", () => {
        expect(formatBytes(0)).toBe("0 B");
    });

    it("formatBytes kb boundary", () => {
        expect(formatBytes(1023)).toBe("1023 B");
        expect(formatBytes(1024)).toBe("1.0 KB");
    });

    it("formatBytes mb / gb", () => {
        expect(formatBytes(1048576)).toBe("1.0 MB");
        expect(formatBytes(1073741824)).toBe("1.0 GB");
    });

    it("formatBytes tb", () => {
        expect(formatBytes(1099511627776)).toBe("1.0 TB");
    });

    it("sumBytes totals an array of findings with reclaimableBytes", () => {
        expect(sumBytes([{ reclaimableBytes: 100 }, { reclaimableBytes: 200 }, {}])).toBe(300);
    });
});
