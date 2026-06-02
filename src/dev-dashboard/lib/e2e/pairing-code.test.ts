import { describe, expect, it } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    generatePairingCode,
    savePairingCode,
    verifyAndConsumePairingCode,
} from "@app/dev-dashboard/lib/e2e/pairing-code";

const T0 = 1_000_000;
const tmpPath = (name: string): string => join(tmpdir(), `dd-pairing-code-${name}.json`);

describe("generatePairingCode", () => {
    it("returns an 8-char code from the unambiguous alphabet (no 0/O/1/I)", () => {
        const code = generatePairingCode();

        expect(code).toHaveLength(8);
        expect(code).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/);
    });
});

describe("verifyAndConsumePairingCode", () => {
    it("accepts the correct code within the window, then consumes it (one-time)", async () => {
        const path = tmpPath("happy");
        await savePairingCode("K7P2M9QX", T0, 300_000, path);

        expect(await verifyAndConsumePairingCode("K7P2M9QX", T0 + 1000, path)).toBe(true);
        // consumed — a second attempt with the same code must fail
        expect(await verifyAndConsumePairingCode("K7P2M9QX", T0 + 2000, path)).toBe(false);
    });

    it("rejects a wrong code WITHOUT consuming (legit user can still retry)", async () => {
        const path = tmpPath("wrong");
        await savePairingCode("K7P2M9QX", T0, 300_000, path);

        expect(await verifyAndConsumePairingCode("WRONGGGG", T0 + 1000, path)).toBe(false);
        // not consumed — the correct code still works
        expect(await verifyAndConsumePairingCode("K7P2M9QX", T0 + 2000, path)).toBe(true);
    });

    it("rejects an expired code", async () => {
        const path = tmpPath("expired");
        await savePairingCode("K7P2M9QX", T0, 300_000, path);

        expect(await verifyAndConsumePairingCode("K7P2M9QX", T0 + 300_001, path)).toBe(false);
    });

    it("rejects when no code file exists", async () => {
        expect(await verifyAndConsumePairingCode("ANYTHING", T0, tmpPath("missing-xyz"))).toBe(false);
    });
});
