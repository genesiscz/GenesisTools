import { describe, expect, it } from "bun:test";
import { sameVolume, volumeUuidAt } from "./volume";

describe("sameVolume", () => {
    it("trusts the UUID over a device number that moved on remount", () => {
        expect(sameVolume({ fsid: "0100000e0000001a", uuid: "A" }, { fsid: "010000100000001a", uuid: "A" })).toBe(true);
    });

    it("reports another volume when the UUIDs differ", () => {
        expect(sameVolume({ fsid: "01", uuid: "A" }, { fsid: "01", uuid: "B" })).toBe(false);
    });

    it("accepts a moved fsid once for an index written before the UUID was stored", () => {
        expect(sameVolume({ fsid: "0100000e0000001a", uuid: null }, { fsid: "010000100000001a", uuid: "A" })).toBe(
            true
        );
    });

    it("falls back to the fsid when no UUID is readable", () => {
        expect(sameVolume({ fsid: "01", uuid: null }, { fsid: "02", uuid: null })).toBe(false);
        expect(sameVolume({ fsid: "01", uuid: null }, { fsid: "01", uuid: null })).toBe(true);
    });

    it("has nothing to compare without a known fsid", () => {
        expect(sameVolume({ fsid: null, uuid: null }, { fsid: "02", uuid: null })).toBe(true);
    });
});

describe.if(process.platform === "darwin")("volumeUuidAt", () => {
    it("names the volume UUID of the home folder", () => {
        expect(volumeUuidAt(process.env.HOME ?? "/")).toMatch(/^[0-9A-F-]{36}$/);
    });
});
