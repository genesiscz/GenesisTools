import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import {
    appendOp,
    closestProcessIds,
    listProcesses,
    newProcessId,
    processJsonlPath,
    readProcess,
    writeMeta,
} from "@app/macos/lib/clones/audit";
import type { ProcessOp } from "@app/macos/lib/clones/render/types";

function op(seq: number, kind: ProcessOp["op"]): ProcessOp {
    return {
        seq,
        ts: new Date().toISOString(),
        op: kind,
        status: kind === "clone" ? "ok" : "already-cloned",
        bytes: kind === "clone" ? 1024 : 0,
        keep: "/k",
        replace: `/r${seq}`,
        modeBefore: 0o644,
        mtimeBeforeMs: 1,
        sha256Before: "abc",
        ...(kind === "clone" ? { sha256After: "abc" } : {}),
    };
}

describe("audit JSONL lifecycle", () => {
    it("meta line + ops replay into a ProcessReport; rollback meta wins for state", () => {
        const id = newProcessId();
        const roots = ["/tmp/x"];
        const startedAt = new Date().toISOString();
        writeMeta({
            id,
            state: "applied",
            roots,
            startedAt,
            endedAt: startedAt,
            planCacheHit: true,
            planCacheAgeMs: 50,
        });
        appendOp(id, op(1, "clone"));
        appendOp(id, op(2, "skip"));

        const path = processJsonlPath(id);
        expect(existsSync(path)).toBe(true);
        expect(readFileSync(path, "utf8").trim().split("\n").length).toBe(3);

        let rep = readProcess(id);
        expect(rep).not.toBeNull();
        expect(rep?.state).toBe("applied");
        expect(rep?.id).toBe(id);
        expect(rep?.roots).toEqual(roots);
        expect(rep?.planCache).toEqual({ hit: true, ageMs: 50 });
        expect(rep?.ops.length).toBe(2);
        expect(rep?.totals).toEqual({ cloned: 1, skipped: 1, errors: 0, bytesReclaimed: 1024 });

        const endedAt = new Date().toISOString();
        writeMeta({
            id,
            state: "rolled-back",
            roots,
            startedAt,
            endedAt,
            planCacheHit: true,
            planCacheAgeMs: 50,
        });
        appendOp(id, op(3, "rollback-uncloned"));
        rep = readProcess(id);
        expect(rep?.state).toBe("rolled-back");
        expect(rep?.endedAt).toBe(endedAt);
        expect(rep?.ops.length).toBe(3);
    });

    it("'aborted' state round-trips — second meta wins over the initial 'applied'", () => {
        const id = newProcessId();
        const startedAt = new Date().toISOString();
        writeMeta({ id, state: "applied", roots: ["/x"], startedAt, endedAt: startedAt, planCacheHit: false });
        // simulate IntegrityError path: runOptimize writes a closing "aborted" meta
        writeMeta({
            id,
            state: "aborted",
            roots: ["/x"],
            startedAt,
            endedAt: new Date().toISOString(),
            planCacheHit: false,
        });
        const rep = readProcess(id);
        expect(rep?.state).toBe("aborted");
    });

    it("listProcesses returns newest-first list entries; closestProcessIds suggests near matches", () => {
        const a = newProcessId();
        writeMeta({
            id: a,
            state: "dry-run",
            roots: ["/a"],
            startedAt: new Date().toISOString(),
            endedAt: new Date().toISOString(),
            planCacheHit: false,
        });
        const list = listProcesses();
        expect(list.processes.some((p) => p.id === a)).toBe(true);
        expect(list.processes[0].startedAt >= list.processes[list.processes.length - 1].startedAt).toBe(true);

        const near = closestProcessIds("zzzz-not-a-real-id");
        expect(Array.isArray(near)).toBe(true);
    });
});

import { mkdtempSync, readFileSync as rf, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as j } from "node:path";
import { runOptimize } from "@app/macos/lib/clones/audit";
import type { DuplicateSet } from "@app/macos/lib/clones/render/types";
import { skip } from "@app/utils/test/skip";

describe.skipIf(skip.unlessMac)("runOptimize apply round-trip", () => {
    it("clones replace files, captures sha-before/after, writes JSONL", () => {
        const dir = mkdtempSync(j(tmpdir(), "gt-cl-apply-"));
        try {
            const payload = Buffer.alloc(512 * 1024, 0x42);
            writeFileSync(j(dir, "keep"), payload);
            writeFileSync(j(dir, "dupA"), payload);
            writeFileSync(j(dir, "dupB"), payload);
            const sets: DuplicateSet[] = [
                {
                    kind: "file",
                    what: "keep",
                    copies: 3,
                    eachBytes: 512 * 1024,
                    reclaimable: 1024 * 1024,
                    members: [j(dir, "keep"), j(dir, "dupA"), j(dir, "dupB")],
                    keep: j(dir, "keep"),
                },
            ];

            const rep = runOptimize({ roots: [dir], sets, planCacheHit: false });
            expect(rep.state).toBe("applied");
            expect(rep.totals.cloned).toBe(2);
            const cloneOps = rep.ops.filter((o) => o.op === "clone");
            expect(cloneOps.length).toBe(2);
            for (const o of cloneOps) {
                expect(o.sha256After).toBe(o.sha256Before);
                expect(o.bytes).toBeGreaterThan(0);
            }

            const onDisk = rf(processJsonlPath(rep.id), "utf8").trim().split("\n");
            expect(onDisk.length).toBe(3);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

import { mkdirSync, statSync as statS } from "node:fs";
import { rollbackProcess } from "@app/macos/lib/clones/audit";
import { getCloneId } from "@app/utils/macos/apfs";

describe.skipIf(skip.unlessMac)("runOptimize DirSet expansion", () => {
    it("dir-kind DuplicateSet: walks both members, clones each matching file pair", () => {
        const dir = mkdtempSync(j(tmpdir(), "gt-cl-dirset-"));
        try {
            const payload1 = Buffer.alloc(64 * 1024, 0xa1);
            const payload2 = Buffer.alloc(48 * 1024, 0xb2);
            mkdirSync(j(dir, "x1", "nested"), { recursive: true });
            mkdirSync(j(dir, "x2", "nested"), { recursive: true });
            writeFileSync(j(dir, "x1", "a.bin"), payload1);
            writeFileSync(j(dir, "x2", "a.bin"), payload1);
            writeFileSync(j(dir, "x1", "nested", "b.bin"), payload2);
            writeFileSync(j(dir, "x2", "nested", "b.bin"), payload2);
            const sets: DuplicateSet[] = [
                {
                    kind: "dir",
                    what: "x1",
                    copies: 2,
                    eachBytes: payload1.length + payload2.length,
                    reclaimable: payload1.length + payload2.length,
                    members: [j(dir, "x1"), j(dir, "x2")],
                    keep: j(dir, "x1"),
                },
            ];
            const rep = runOptimize({ roots: [dir], sets, planCacheHit: false });
            // x2/a.bin and x2/nested/b.bin should each clone from x1's matching file
            expect(rep.totals.cloned).toBe(2);
            expect(rep.totals.errors).toBe(0);
            expect(getCloneId(j(dir, "x2", "a.bin"))).toBe(getCloneId(j(dir, "x1", "a.bin")));
            expect(getCloneId(j(dir, "x2", "nested", "b.bin"))).toBe(getCloneId(j(dir, "x1", "nested", "b.bin")));
            // each per-file op recorded distinctly
            const cloneOps = rep.ops.filter((o) => o.op === "clone");
            expect(cloneOps.length).toBe(2);
            const replaces = cloneOps.map((o) => o.replace).sort();
            expect(replaces).toEqual([j(dir, "x2", "a.bin"), j(dir, "x2", "nested", "b.bin")].sort());
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe.skipIf(skip.unlessMac)("rollbackProcess un-shares clones", () => {
    it("apply then rollback: replace no longer shares keep's clone id, content unchanged, audit chained", () => {
        const dir = mkdtempSync(j(tmpdir(), "gt-cl-rb-"));
        try {
            const payload = Buffer.alloc(256 * 1024, 0x77);
            writeFileSync(j(dir, "keep"), payload);
            writeFileSync(j(dir, "dup"), payload);
            const sets: DuplicateSet[] = [
                {
                    kind: "file",
                    what: "keep",
                    copies: 2,
                    eachBytes: 256 * 1024,
                    reclaimable: 256 * 1024,
                    members: [j(dir, "keep"), j(dir, "dup")],
                    keep: j(dir, "keep"),
                },
            ];
            const applied = runOptimize({ roots: [dir], sets, planCacheHit: false });
            expect(applied.totals.cloned).toBe(1);
            expect(getCloneId(j(dir, "dup"))).toBe(getCloneId(j(dir, "keep")));

            const rolled = rollbackProcess(applied.id);
            expect(rolled.state).toBe("rolled-back");
            expect(rolled.ops.some((o) => o.op === "rollback-uncloned")).toBe(true);
            expect(getCloneId(j(dir, "dup"))).not.toBe(getCloneId(j(dir, "keep")));
            expect(rf(j(dir, "dup"), "utf8")).toBe(rf(j(dir, "keep"), "utf8"));
            expect(statS(j(dir, "dup")).mode & 0o7777).toBe(applied.ops[0].modeBefore);

            const lines = rf(processJsonlPath(applied.id), "utf8").trim().split("\n");
            expect(lines.length).toBeGreaterThanOrEqual(4);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
