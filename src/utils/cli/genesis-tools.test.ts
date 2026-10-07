import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { type DetectProbes, detectGenesisTools, resetGenesisToolsCache } from "./genesis-tools";

afterEach(() => {
    resetGenesisToolsCache();
});

function probes(overrides: Partial<DetectProbes> = {}): DetectProbes {
    return {
        which: () => null,
        roots: () => [],
        exists: () => false,
        ...overrides,
    };
}

describe("detectGenesisTools", () => {
    test("a PATH hit is the binary", () => {
        expect(detectGenesisTools(probes({ which: () => "/fake/bin/tools" }))).toEqual({ binPath: "/fake/bin/tools" });
    });

    test("without PATH, the first root holding a tools file is used", () => {
        const handle = detectGenesisTools(
            probes({
                roots: () => [undefined, "  ", "/opt/Missing", "/opt/GenesisTools"],
                exists: (path) => path === join("/opt/GenesisTools", "tools"),
            })
        );

        expect(handle).toEqual({ binPath: join("/opt/GenesisTools", "tools") });
    });

    test("missing everywhere is null", () => {
        expect(detectGenesisTools(probes({ roots: () => ["/opt/Missing"] }))).toBeNull();
    });

    test("detection is cached per process", () => {
        let calls = 0;
        const counting = probes({
            which: () => {
                calls++;

                return "/fake/bin/tools";
            },
        });

        detectGenesisTools(counting);
        detectGenesisTools(counting);
        expect(calls).toBe(1);
    });
});
