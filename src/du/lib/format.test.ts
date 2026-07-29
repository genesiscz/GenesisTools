import { describe, expect, it } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pc from "picocolors";
import { diffScans, humanBytes, humanBytesDecimal, renderDenied, renderHuman, renderTree } from "./format";
import type { ClonesizeResult, NodeResult } from "./types";

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI escapes for assertions
const stripAnsi = (s: string): string => s.replace(/\[[0-9;]*m/g, "");

const ROOT = join(tmpdir(), "du-fmt-root");
const SMALL = join(ROOT, "small");
const BIG = join(ROOT, "big");
const DUPE = join(ROOT, "dupe");

function baseResult(nodes: NodeResult[]): ClonesizeResult {
    return {
        path: ROOT,
        files_scanned: 3,
        files_listed: 3,
        extents: 0,
        threads: 1,
        naive_bytes: 0,
        unique_bytes: 0,
        shared_bytes: 0,
        shared_pct: 0,
        cross_group_shared_bytes: 0,
        depth: 1,
        nodes,
        groups: [],
    };
}

function node(over: Partial<NodeResult>): NodeResult {
    return {
        path: ROOT,
        depth: 0,
        parent: -1,
        naive_bytes: 0,
        unique_bytes: 0,
        cross_shared_bytes: 0,
        shared_pct: 0,
        files: 0,
        clone_flagged: false,
        ...over,
    };
}

describe("humanBytes", () => {
    it("formats bytes below 1 KB as raw bytes", () => {
        expect(humanBytes(0)).toBe("0 B");
        expect(humanBytes(512)).toBe("512 B");
        expect(humanBytes(1023)).toBe("1023 B");
    });

    it("formats KB / MB / GB / TB at their thresholds", () => {
        expect(humanBytes(1024)).toBe("1.0 KB");
        expect(humanBytes(1024 * 1024)).toBe("1.0 MB");
        expect(humanBytes(1024 * 1024 * 1024)).toBe("1.00 GB");
        expect(humanBytes(1024 * 1024 * 1024 * 1024)).toBe("1.00 TB");
    });

    it("stays in the lower unit just below each threshold", () => {
        expect(humanBytes(1024 * 1024 - 1)).toContain("KB");
        expect(humanBytes(1024 * 1024 * 1024 - 1)).toContain("MB");
    });
});

describe("renderTree", () => {
    it("renders a header even with no nodes", () => {
        const out = stripAnsi(renderTree(baseResult([]), "c-ffi"));
        expect(out).toContain(`Clone-aware disk tree — ${ROOT}`);
        // No node rows emitted.
        expect(out).not.toContain(`${ROOT}/`);
    });

    it("renders a single root node", () => {
        const out = stripAnsi(renderTree(baseResult([node({ naive_bytes: 2048, unique_bytes: 2048 })]), "c-ffi"));
        expect(out).toContain(ROOT);
        expect(out).toContain("2.0 KB");
    });

    it("sorts children by unique bytes descending", () => {
        const nodes = [
            node({ path: ROOT, parent: -1 }),
            node({ path: SMALL, depth: 1, parent: 0, unique_bytes: 100 }),
            node({ path: BIG, depth: 1, parent: 0, unique_bytes: 300 }),
        ];
        const out = stripAnsi(renderTree(baseResult(nodes), "c-ffi"));
        expect(out.indexOf("big")).toBeLessThan(out.indexOf("small"));
    });

    it("highlights a clone_flagged node in yellow when colors are enabled", () => {
        const nodes = [
            node({ path: ROOT, parent: -1 }),
            node({ path: DUPE, depth: 1, parent: 0, unique_bytes: 100, clone_flagged: true }),
        ];
        const raw = renderTree(baseResult(nodes), "c-ffi");
        expect(stripAnsi(raw)).toContain("dupe");
        if (pc.isColorSupported) {
            expect(raw).toContain(pc.yellow("dupe"));
        }
    });
});

describe("humanBytesDecimal", () => {
    it("uses base-10 units so the volume reconcile lines up with diskutil", () => {
        expect(humanBytesDecimal(1000)).toBe("1.0 KB");
        expect(humanBytesDecimal(1_000_000_000)).toBe("1.0 GB");
        // The exact figure diskutil printed for this machine's Data volume.
        expect(humanBytesDecimal(942_235_377_664)).toBe("942.2 GB");
    });

    it("differs from the binary formatter, which is why both exist", () => {
        expect(humanBytes(1_000_000_000)).not.toBe(humanBytesDecimal(1_000_000_000));
    });
});

describe("renderDenied", () => {
    it("prints nothing when the scan read everything", () => {
        expect(renderDenied({ denied_dirs: 0, denied_files: 0, denied_paths: [] })).toEqual([]);
        expect(renderDenied({})).toEqual([]);
    });

    it("names the unreadable paths and offers a sudo command", () => {
        const lines = stripAnsi(
            renderDenied({
                denied_dirs: 1,
                denied_files: 0,
                denied_paths: ["/System/Volumes/Data/.fseventsd"],
            }).join("\n")
        );
        expect(lines).toContain("INCOMPLETE");
        expect(lines).toContain("/System/Volumes/Data/.fseventsd");
        expect(lines).toContain("sudo tools du clonesize /System/Volumes/Data/.fseventsd");
    });

    it("reports denials it could not keep a path for", () => {
        const lines = stripAnsi(renderDenied({ denied_dirs: 100, denied_files: 0, denied_paths: ["/a"] }).join("\n"));
        expect(lines).toContain("99 further denial(s) not listed");
    });
});

describe("diffScans", () => {
    const scan = (nodes: NodeResult[]): ClonesizeResult => baseResult(nodes);

    it("returns no rows for two identical scans", () => {
        const nodes = [node({ path: ROOT, parent: -1, unique_allocated_bytes: 4096 })];
        expect(diffScans(scan(nodes), scan(nodes))).toEqual([]);
    });

    it("reports a new directory with its full size as the delta", () => {
        const before = scan([node({ path: ROOT, parent: -1, unique_allocated_bytes: 4096 })]);
        const after = scan([
            node({ path: ROOT, parent: -1, unique_allocated_bytes: 8192 }),
            node({ path: BIG, depth: 1, parent: 0, unique_allocated_bytes: 4096 }),
        ]);
        const rows = diffScans(before, after);
        expect(rows.map((r) => r.path)).toEqual([ROOT, BIG]);
        expect(rows.find((r) => r.path === BIG)).toMatchObject({ status: "new", delta: 4096, before: 0 });
        expect(rows.find((r) => r.path === ROOT)).toMatchObject({ status: "grown", delta: 4096 });
    });

    it("reports a removed directory as gone with a negative delta", () => {
        const before = scan([
            node({ path: ROOT, parent: -1, unique_allocated_bytes: 8192 }),
            node({ path: SMALL, depth: 1, parent: 0, unique_allocated_bytes: 4096 }),
        ]);
        const after = scan([node({ path: ROOT, parent: -1, unique_allocated_bytes: 4096 })]);
        const rows = diffScans(before, after);
        expect(rows.find((r) => r.path === SMALL)).toMatchObject({ status: "gone", delta: -4096, after: 0 });
    });

    it("falls back to mapped bytes when a snapshot predates unique_allocated_bytes", () => {
        const before = scan([node({ path: ROOT, parent: -1, unique_bytes: 1000 })]);
        const after = scan([node({ path: ROOT, parent: -1, unique_bytes: 3000 })]);
        expect(diffScans(before, after)[0]).toMatchObject({ delta: 2000, status: "grown" });
    });

    it("sorts the biggest absolute change first, shrink or grow", () => {
        const before = scan([
            node({ path: ROOT, parent: -1, unique_allocated_bytes: 100 }),
            node({ path: SMALL, depth: 1, parent: 0, unique_allocated_bytes: 10_000 }),
            node({ path: BIG, depth: 1, parent: 0, unique_allocated_bytes: 100 }),
        ]);
        const after = scan([
            node({ path: ROOT, parent: -1, unique_allocated_bytes: 150 }),
            node({ path: SMALL, depth: 1, parent: 0, unique_allocated_bytes: 0 }),
            node({ path: BIG, depth: 1, parent: 0, unique_allocated_bytes: 200 }),
        ]);
        expect(diffScans(before, after)[0]).toMatchObject({ path: SMALL, status: "shrunk", delta: -10_000 });
    });
});

describe("renderHuman ordering and scope warnings", () => {
    const flat = (over: Partial<ClonesizeResult>): ClonesizeResult => ({
        ...baseResult([]),
        naive_bytes: 314572800,
        unique_bytes: 314572800,
        unique_allocated_bytes: 314572800,
        private_sum_bytes: 0,
        ...over,
    });

    it("puts the freeable figure above 'Real unique on disk'", () => {
        const out = stripAnsi(renderHuman(flat({}), "c-ffi"));
        expect(out.indexOf("Deleting this frees")).toBeLessThan(out.indexOf("Real unique on disk"));
    });

    it("labels unique as scan-scoped so it cannot be read as volume-wide", () => {
        expect(stripAnsi(renderHuman(flat({}), "c-ffi"))).toContain("deduped WITHIN this scan only");
    });

    it("warns when blocks are also referenced outside the scan root", () => {
        const out = stripAnsi(renderHuman(flat({ outside_shared_bytes: 314572800 }), "c-ffi"));
        expect(out).toContain("Shared OUTSIDE this scan");
        expect(out).toContain("ALSO referenced outside the scan root");
        expect(out).toContain("Scan the parent directory");
    });

    it("stays silent about outside sharing when there is none", () => {
        const out = stripAnsi(renderHuman(flat({ outside_shared_bytes: 0 }), "c-ffi"));
        expect(out).not.toContain("OUTSIDE");
    });
});
