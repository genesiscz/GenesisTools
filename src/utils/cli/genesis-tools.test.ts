import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { type DetectProbes, detectGenesisTools, genesisToolsCheckout, resetGenesisToolsCache } from "./genesis-tools";

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

const MAIN = "/work/GenesisTools";
const WORKTREE = "/work/GenesisTools/.claude/worktrees/feat-x";
const MARKER = join("src", "utils", "cli", "genesis-tools.ts");

/** Both checkouts exist on disk: each has its `tools` and the marker file. */
const checkouts = (path: string): boolean =>
    [MAIN, WORKTREE].some((root) => path === join(root, "tools") || path === join(root, MARKER));

describe("the working directory comes first", () => {
    test("inside a worktree, that worktree's tools wins over GENESIS_TOOLS_PATH and PATH (the main checkout)", () => {
        const handle = detectGenesisTools(
            probes({
                cwd: () => join(WORKTREE, "src", "hub"),
                roots: () => [MAIN],
                which: () => join(MAIN, "tools"),
                exists: checkouts,
            })
        );

        expect(handle).toEqual({ binPath: join(WORKTREE, "tools") });
    });

    test("the walk stops at the nearest checkout and needs the marker, not just a file named tools", () => {
        expect(genesisToolsCheckout(join(WORKTREE, "src"), checkouts)).toBe(WORKTREE);
        expect(genesisToolsCheckout(join(MAIN, "docs"), checkouts)).toBe(MAIN);
        // A folder with some other `tools` script is not a GenesisTools checkout.
        expect(genesisToolsCheckout("/elsewhere/app", (path) => path === "/elsewhere/app/tools")).toBeNull();
    });

    test("outside any checkout, GENESIS_TOOLS_PATH comes before PATH", () => {
        const handle = detectGenesisTools(
            probes({
                cwd: () => "/Users/someone/other-repo",
                roots: () => ["/opt/GenesisTools"],
                which: () => "/usr/local/bin/tools",
                exists: (path) => path === join("/opt/GenesisTools", "tools"),
            })
        );

        expect(handle).toEqual({ binPath: join("/opt/GenesisTools", "tools") });
    });
});

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
