import { describe, expect, it } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pc from "picocolors";
import { humanBytes, renderTree } from "./format";
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
