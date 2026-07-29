import { describe, expect, it } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pc from "picocolors";
import {
    diffScans,
    humanBytes,
    humanBytesDecimal,
    renderDenied,
    renderHuman,
    renderPartners,
    renderTree,
    renderVolume,
} from "./format";
import type { ClonesizeResult, NodeResult, PartnersResult, VolumeInfo } from "./types";

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

describe("renderVolume", () => {
    const volume = (over: Partial<VolumeInfo> = {}): VolumeInfo => ({
        mount: "/System/Volumes/Data",
        size_bytes: 1_000_000_000_000,
        used_bytes: 900_000_000_000,
        free_bytes: 100_000_000_000,
        available_bytes: 100_000_000_000,
        ...over,
    });

    const scanned = (over: Partial<ClonesizeResult> = {}): ClonesizeResult => ({
        ...baseResult([]),
        nodes: undefined,
        depth: undefined,
        unique_allocated_bytes: 800_000_000_000,
        ...over,
    });

    it("reports the gap between APFS used-bytes and what the walk could see", () => {
        const text = stripAnsi(renderVolume(volume(), scanned()));

        expect(text).toContain("Volume reconcile — /System/Volumes/Data");
        expect(text).toContain("Volume used (APFS)");
        // 900 GB used - 800 GB scanned = 100 GB the walk never accounted for.
        expect(text).toContain("UNACCOUNTED");
        expect(text).toContain("100.0 GB");
        expect(text).toContain("(11.1% of used)");
    });

    it("prefers allocated bytes over mapped bytes as the scanned figure", () => {
        // unique_bytes understates real consumption by each file's sub-block slack,
        // so the reconcile must use unique_allocated_bytes when it is present.
        const text = stripAnsi(
            renderVolume(volume(), scanned({ unique_bytes: 500_000_000_000, unique_allocated_bytes: 800_000_000_000 }))
        );

        expect(text).toContain("800.0 GB");
        expect(text).not.toContain("500.0 GB");
    });

    it("falls back to mapped bytes when the scan has no allocated figure", () => {
        const text = stripAnsi(
            renderVolume(volume(), scanned({ unique_bytes: 700_000_000_000, unique_allocated_bytes: undefined }))
        );

        expect(text).toContain("700.0 GB");
        expect(text).toContain("200.0 GB");
    });

    it("labels a scan that exceeds volume used-bytes as over-counted, not negative", () => {
        const text = stripAnsi(renderVolume(volume(), scanned({ unique_allocated_bytes: 950_000_000_000 })));

        expect(text).toContain("over-counted");
        expect(text).not.toContain("UNACCOUNTED");
        expect(text).toContain("50.0 GB");
    });

    it("names skipped cloud roots, which are a silent hole in the total", () => {
        const text = stripAnsi(
            renderVolume(volume(), scanned({ skipped_cloud: ["/Users/x/Library/CloudStorage/Dropbox"] }))
        );

        expect(text).toContain("1 cloud-provider root(s) were NOT walked");
        expect(text).toContain("/Users/x/Library/CloudStorage/Dropbox");
        expect(text).toContain("--include-cloud");
    });

    it("truncates a long skipped-mount list instead of flooding the report", () => {
        const mounts = Array.from({ length: 12 }, (_v, i) => `/mnt/vol${i}`);
        const text = stripAnsi(renderVolume(volume(), scanned({ skipped_mounts: mounts })));

        expect(text).toContain("12 mount point(s) of other filesystems were skipped");
        expect(text).toContain("/mnt/vol7");
        expect(text).not.toContain("/mnt/vol8");
        expect(text).toContain("... and 4 more");
    });

    it("blames denials for the gap and offers the sudo rerun", () => {
        const text = stripAnsi(
            renderVolume(volume(), scanned({ denied_dirs: 3, denied_files: 1, denied_paths: ["/private/var/db/x"] }))
        );

        expect(text).toContain("4 unreadable path(s) — the prime suspect for the gap");
        expect(text).toContain("/private/var/db/x");
        expect(text).toContain("sudo tools du volume /System/Volumes/Data");
    });

    it("still reports denials when the scan over-counts instead of under-counting", () => {
        // A volume can exceed used_bytes (clones counted on both sides, purgeable
        // churn) and still be missing hundreds of unreadable paths. Gating the
        // denial block on a positive gap hid them in exactly that case.
        const text = stripAnsi(
            renderVolume(
                volume(),
                scanned({
                    unique_allocated_bytes: 950_000_000_000,
                    denied_dirs: 7,
                    denied_files: 2,
                    denied_paths: ["/private/var/db/locked"],
                })
            )
        );

        expect(text).toContain("over-counted");
        expect(text).toContain("9 unreadable path(s)");
        expect(text).toContain("every total above is INCOMPLETE");
        expect(text).toContain("/private/var/db/locked");
        expect(text).toContain("sudo tools du volume /System/Volumes/Data");
        // The gap framing only applies when there actually is a gap.
        expect(text).not.toContain("prime suspect");
    });

    it("says the gap is metadata when nothing was denied", () => {
        const text = stripAnsi(renderVolume(volume(), scanned()));

        expect(text).toContain("volume metadata, snapshots, or purgeable space");
        expect(text).not.toContain("unreadable path(s)");
    });
});

describe("renderPartners", () => {
    const partners = (over: Partial<PartnersResult> = {}): PartnersResult => ({
        target: "/repo/.worktrees/feat-x",
        root: "/repo",
        target_shared_bytes: 300 * 1024 * 1024,
        partner_bytes: 600 * 1024 * 1024,
        partner_files_total: 12,
        files_opened: 40,
        denied_dirs: 0,
        denied_files: 0,
        partner_dirs: [],
        partner_files: [],
        ...over,
    });

    it("says so plainly when nothing under the search root holds the blocks", () => {
        const text = stripAnsi(renderPartners(partners()));

        expect(text).toContain("Clone partners of /repo/.worktrees/feat-x");
        expect(text).toContain("No partners under /repo");
        expect(text).not.toContain("Partner directories:");
    });

    it("lists partner dirs and files with their shared bytes", () => {
        const text = stripAnsi(
            renderPartners(
                partners({
                    partner_dirs: [{ path: "/repo/node_modules", shared_bytes: 200 * 1024 * 1024, files: 7 }],
                    partner_files: [{ path: "/repo/node_modules/a.bin", shared_bytes: 50 * 1024 * 1024 }],
                })
            )
        );

        expect(text).toContain("Partner directories:");
        expect(text).toContain("/repo/node_modules");
        expect(text).toContain("200.0 MB");
        expect(text).toContain("Partner files:");
        expect(text).toContain("/repo/node_modules/a.bin");
        expect(text).toContain("50.0 MB");
        // The whole point of the command: these blocks are not freed by deleting.
        expect(text).toContain("Deleting the target frees nothing that a partner still references");
    });

    it("truncates long paths from the left so the filename stays readable", () => {
        const deep = `/repo/${"nested/".repeat(20)}leaf.bin`;
        const text = stripAnsi(
            renderPartners(
                partners({
                    // An empty partner_dirs list short-circuits before the file rows,
                    // so a dir has to be present for this path to be exercised at all.
                    partner_dirs: [{ path: "/repo/node_modules", shared_bytes: 1024, files: 1 }],
                    partner_files: [{ path: deep, shared_bytes: 1024 * 1024 }],
                })
            )
        );

        expect(text).toContain("leaf.bin");
        expect(text).toContain("…");
        expect(text).not.toContain(deep);
    });

    it("surfaces denials, since unreadable dirs mean partners may be missing", () => {
        // The partners JSON carries counts only — clonesize_partners_json emits
        // denied_dirs/denied_files and never denied_paths — so the warning has to
        // stand on the count alone.
        const text = stripAnsi(renderPartners(partners({ denied_dirs: 2, denied_files: 1 })));

        expect(text).toContain("2 directories and 1 file(s) could not be read");
        expect(text).toContain("every total above is INCOMPLETE");
        expect(text).toContain("(3 further denial(s) not listed)");
    });
});
