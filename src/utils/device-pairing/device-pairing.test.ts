import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { bearerToken } from "./client";
import { DeviceStore, hashToken, MAX_PAIR_FAILURES } from "./device-store";

describe("device pairing", () => {
    let dir: string;
    let file: string;
    let devices: DeviceStore;
    let clock: number;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), "device-pairing-"));
        file = join(dir, "devices.json");
        clock = Date.parse("2026-01-01T00:00:00Z");
        devices = new DeviceStore({ file, tokenPrefix: "gtshare_", now: () => clock });
    });

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    test("recognizes bearer schemes without changing token case", () => {
        expect(
            bearerToken(
                new Request("https://share.example.com", {
                    headers: { Authorization: "bearer MixedCaseToken" },
                })
            )
        ).toBe("MixedCaseToken");
        expect(
            bearerToken(
                new Request("https://share.example.com", {
                    headers: { Authorization: "Basic MixedCaseToken" },
                })
            )
        ).toBeNull();
    });

    test("a pairing code works once, the server keeps only the token's hash, and the token authenticates", async () => {
        const { code } = devices.createPairingCode();
        const paired = await devices.pair(code, "work");

        expect(paired).not.toBeNull();
        expect(await devices.pair(code, "again")).toBeNull();

        const stored = readFileSync(file, "utf8");
        expect(stored).not.toContain(paired?.token ?? "missing");
        expect(stored).toContain(hashToken(paired?.token ?? ""));
        expect((await devices.authenticate(paired?.token ?? ""))?.name).toBe("work");
        expect(await devices.authenticate("gtshare_not-a-real-token")).toBeNull();
    });

    test("an expired code fails, and enough wrong codes drop every pending code", async () => {
        const expired = devices.createPairingCode(1000);
        clock += 2000;
        expect(await devices.pair(expired.code, "late")).toBeNull();

        const live = devices.createPairingCode();

        for (let attempt = 0; attempt < MAX_PAIR_FAILURES; attempt++) {
            expect(await devices.pair("WRONG-CODE", "guess")).toBeNull();
        }

        expect(await devices.pair(live.code, "too late")).toBeNull();
    });

    test("concurrent redemptions preserve both devices in the version 1 file", async () => {
        const first = devices.createPairingCode();
        const second = devices.createPairingCode();
        const paired = await Promise.all([devices.pair(first.code, "desk"), devices.pair(second.code, "laptop")]);

        const reloaded = new DeviceStore({ file, tokenPrefix: "gtshare_", now: () => clock });
        const saved = await reloaded.list();
        expect(saved.map(({ name }) => name).sort()).toEqual(["desk", "laptop"]);
        expect(saved.map(({ tokenHash }) => tokenHash).sort()).toEqual(
            paired.map((entry) => hashToken(entry?.token ?? "")).sort()
        );
    });

    test("a token on disk from the old server authenticates after reload", async () => {
        const token = "gtshare_0123456789abcdef0123456789abcdef0123456789a";
        const device = {
            id: "0123456789ab",
            name: "desk",
            tokenHash: "11c81b1f6fdc893f8594699c16c2b405090387528d2205ccd80165d5aa627e55",
            createdAt: new Date(clock).toISOString(),
        };
        writeFileSync(file, SafeJSON.stringify({ version: 1, devices: [device] }), { mode: 0o600 });

        const reloaded = new DeviceStore({ file, tokenPrefix: "another_", now: () => clock });
        expect(await reloaded.authenticate(token)).toEqual(device);
        expect(await devices.list()).toEqual([{ ...device, lastUsedAt: new Date(clock).toISOString() }]);
    });
});
