import { describe, expect, test } from "bun:test";
import { hashClientPassword } from "./server";
import { buildMagicPacket, sendWakePacket } from "./wol";

describe("buildMagicPacket", () => {
    const mac = new Uint8Array([0xaa, 0xbb, 0xcc, 0x00, 0x11, 0x22]);

    test("6xFF header followed by 16 MAC repetitions", () => {
        const packet = buildMagicPacket(mac, null);
        expect(packet.length).toBe(6 + 16 * 6);
        expect([...packet.subarray(0, 6)]).toEqual([0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);

        for (let i = 0; i < 16; i++) {
            expect([...packet.subarray(6 + i * 6, 6 + (i + 1) * 6)]).toEqual([...mac]);
        }
    });

    test("SecureOn password appended as trailing 6 bytes", () => {
        const password = new Uint8Array([1, 2, 3, 4, 5, 6]);
        const packet = buildMagicPacket(mac, password);
        expect(packet.length).toBe(6 + 16 * 6 + 6);
        expect([...packet.subarray(packet.length - 6)]).toEqual([...password]);
    });
});

describe("sendWakePacket validation", () => {
    test("rejects malformed MAC", async () => {
        await expect(sendWakePacket({ mac: "not-a-mac" })).rejects.toThrow(/Invalid MAC address/);
    });

    test("rejects wrong-length SecureOn password", async () => {
        await expect(sendWakePacket({ mac: "aa:bb:cc:00:11:22", password: "abcd" })).rejects.toThrow(
            /SecureOn password/
        );
    });

    test("rejects NaN and out-of-range ports", async () => {
        await expect(sendWakePacket({ mac: "aa:bb:cc:00:11:22", port: Number.NaN })).rejects.toThrow(
            /Invalid UDP port/
        );
        await expect(sendWakePacket({ mac: "aa:bb:cc:00:11:22", port: 70000 })).rejects.toThrow(/Invalid UDP port/);
    });
});

describe("hashClientPassword", () => {
    test("deterministic sha256 hex, never the plaintext", () => {
        const digest = hashClientPassword("hunter2");
        expect(digest).toMatch(/^[0-9a-f]{64}$/);
        expect(digest).toBe(hashClientPassword("hunter2"));
        expect(digest).not.toContain("hunter2");
    });
});
