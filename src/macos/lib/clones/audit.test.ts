import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "bun:test";
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
