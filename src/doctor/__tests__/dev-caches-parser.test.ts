import { afterAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDockerSystemDfJson, parseSimctlJson } from "@app/doctor/analyzers/dev-caches";
import { compressionHintFinding, readCompressionHint } from "@app/doctor/lib/compression-hint";
import { toJsonFinding } from "@app/doctor/ui/json";

const FIXTURES = join(import.meta.dir, "fixtures");
const scratchRoots: string[] = [];
afterAll(() => {
    for (const root of scratchRoots) {
        rmSync(root, { recursive: true, force: true });
    }
});

describe("parseSimctlJson", () => {
    it("parses devices into a flat array with runtime suffix", () => {
        const raw = readFileSync(join(FIXTURES, "simctl-devices.json"), "utf8");
        const devices = parseSimctlJson(raw);

        expect(devices.length).toBe(6);
        expect(devices[0].runtime).toContain("iOS");
        expect(devices[0].udid).toMatch(/[A-F0-9-]+/i);
    });

    it("returns [] on invalid JSON", () => {
        expect(parseSimctlJson("not json")).toEqual([]);
    });
});

describe("parseDockerSystemDfJson", () => {
    it("parses docker system df JSON objects split by line", () => {
        const raw = [
            '{"Type":"Images","TotalCount":"12","Active":"3","Size":"18.2GB","Reclaimable":"11.1GB (61%)"}',
            '{"Type":"Local Volumes","TotalCount":"4","Active":"1","Size":"2.5GB","Reclaimable":"2.0GB (80%)"}',
        ].join("\n");

        const summary = parseDockerSystemDfJson(raw);
        expect(summary).toContainEqual({
            type: "Images",
            totalCount: 12,
            active: 3,
            size: "18.2GB",
            reclaimable: "11.1GB (61%)",
        });
    });
});

describe("transparent compression scan hint", () => {
    it("omits an estimate at or below 1 GB", () => {
        expect(compressionHintFinding([])).toBeNull();
        expect(compressionHintFinding([{ path: "/fixture/history", savingBytes: 1_000_000_000 }])).toBeNull();
    });

    it("shows the best checked estimate with a quoted plan command and no reclaim action", () => {
        const hint = compressionHintFinding([
            { path: "/fixture/small", savingBytes: 100 },
            { path: "/fixture/session history", savingBytes: 2_000_000_000 },
        ]);
        expect(hint?.metadata?.command).toBe("tools compress transparent plan '/fixture/session history'");
        expect(hint?.metadata?.estimatedSavingBytes).toBe(2_000_000_000);
        expect(hint?.detail).toContain("Estimated saving from checked files");
        expect(hint?.detail).toContain(String(hint?.metadata?.command));
        expect(hint?.actions).toEqual([]);
        expect(hint?.reclaimableBytes).toBeUndefined();
        expect(hint?.metadata?.paths).toBeUndefined();
        expect(hint).not.toBeNull();
        if (hint) {
            const wire = toJsonFinding(hint, false);
            expect(wire.availableActionIds).toEqual([]);
            expect(wire.pathsHash).toBeNull();
            expect(wire.metadata?.command).toBe(hint.metadata?.command);
        }
    });
});

it.skipIf(process.platform !== "darwin")(
    "bounds compression discovery and sampling without reaching live files",
    async () => {
        const root = join(tmpdir(), "cc", "GenesisTools", "compression-hint-tests", randomUUID());
        mkdirSync(root, { recursive: true });
        scratchRoots.push(root);
        for (let index = 0; index < 520; index++) {
            writeFileSync(join(root, `${index}.txt`), "x".repeat(4096));
        }
        let flagged = 0;
        let sampled = 0;
        let timeoutMs = 0;
        const config = async () => ({
            defaults: { olderThan: "3d", minKb: 0, exts: ["txt"] },
            harnesses: { fixture: { roots: [root] } },
        });
        await readCompressionHint({
            config,
            opened: async (options) => {
                timeoutMs = options?.timeoutMs ?? 0;
                return new Set();
            },
            flags: () => {
                flagged++;
                return 0;
            },
            privateSize: () => 4096,
            ratio: () => {
                sampled++;
                return 0.1;
            },
            now: () => Date.now() + 4 * 86_400_000,
        });
        expect(flagged).toBe(513);
        expect(sampled).toBe(32);
        expect(timeoutMs).toBe(1000);
        expect(readFileSync(join(root, "0.txt"), "utf8")).toBe("x".repeat(4096));
        const uncertain = await readCompressionHint({
            config,
            opened: async () => new Set(),
            flags: () => 0,
            privateSize: () => null,
            ratio: () => {
                throw new Error("Unknown sharing must never reach content sampling");
            },
            now: () => Date.now() + 4 * 86_400_000,
        });
        expect(uncertain).toBeNull();

        flagged = 0;
        let clock = 0;
        await readCompressionHint({
            config,
            opened: async () => new Set(),
            flags: () => {
                flagged++;
                return 0;
            },
            now: () => {
                clock += 1000;
                return clock;
            },
        });
        expect(flagged).toBeLessThanOrEqual(2);
    }
);
