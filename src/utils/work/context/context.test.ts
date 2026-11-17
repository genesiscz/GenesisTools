import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Actor } from "../model/item";
import { asItemId } from "../model/item";
import { showItem } from "../read";
import { type WorkContext, write } from "../service";
import { applyChange } from "../store/apply";
import { openWorkDb } from "../store/db";
import { type ContextFact, type ContextView, gatherContext, pickCurrent, stampOf } from ".";

const actor: Actor = {
    kind: "agent",
    harness: "claude",
    sessionId: "s1",
    sessionTitle: null,
    model: null,
    host: null,
    subagentId: null,
    project: "Proj",
    repoRoot: null,
    branch: null,
    commitSha: null,
};

let db: Database;
let n = 0;

beforeEach(() => {
    db = openWorkDb(":memory:");
});

afterEach(() => {
    db.close();
});

function view(over: Partial<ContextView> = {}): ContextView {
    return {
        actor,
        lineage: ["s1"],
        branch: null,
        head: null,
        originUrl: null,
        network: false,
        db,
        bindings: [],
        ...over,
    };
}

function ctx(over: Partial<WorkContext> = {}): WorkContext {
    return {
        db,
        actor,
        project: "Proj",
        ports: {
            legacy: { write: async () => ({ ok: false }) },
            delivery: { place: async () => null, deliver: async () => ({ outcome: "unknown", to: null, at: "" }) },
        },
        random: () => `id${String(n++).padStart(6, "0")}`,
        ...over,
    };
}

async function epic(title: string): Promise<string> {
    const reply = await write(ctx(), { verb: "add", title, type: "epic" });
    return reply.ok ? reply.data.items[0].id : "";
}

function fact(
    path: string,
    value: string,
    method: ContextFact["how"]["method"],
    strength?: "strong" | "weak"
): ContextFact {
    return {
        provider: "t",
        path,
        value,
        how: { method, source: "t", evidence: "t", ...(strength ? { strength } : {}) },
    };
}

describe("pickCurrent", () => {
    test("given beats read beats inferred; a weak or split inference stays a candidate", () => {
        const report = pickCurrent([
            fact("handoff", "h_read0001", "read"),
            fact("handoff", "h_infer001", "inferred", "strong"),
            fact("pr", "url-a", "inferred", "weak"),
            fact("bound.improve", "x", "given"),
        ]);
        expect(report.current.handoff.value).toBe("h_read0001");
        expect(report.current["bound.improve"].value).toBe("x");
        expect(report.current.pr).toBeUndefined();
        expect(report.candidates.map((c) => c.value).sort()).toEqual(["h_infer001", "url-a"]);
        expect(
            pickCurrent([fact("handoff", "a", "read"), fact("handoff", "b", "read")]).current.handoff
        ).toBeUndefined();
    });
});

describe("providers", () => {
    test("a live claim is read; a branch that names an open item is a strong inference", async () => {
        const claimed = await epic("claimed");
        applyChange(db, {
            v: 1,
            ts: "2026-11-17T20:00:00.000Z",
            item: asItemId(claimed),
            actor,
            kind: "claimed",
            payload: {},
            origin: { via: "local" },
        });
        const read = await gatherContext(view());
        expect(read.current.handoff.value).toBe(claimed);
        expect(read.current.handoff.how.method).toBe("read");

        db.run("UPDATE claims SET active = 0");
        const named = await epic("named");
        const inferred = await gatherContext(view({ branch: `fix/${named}-thing` }));
        expect(inferred.current.handoff.value).toBe(named);
        expect(inferred.current.handoff.how).toMatchObject({
            method: "inferred",
            source: "git.branch",
            strength: "strong",
        });
    });

    test("a spot pairs through a strong inference with the warning CONTEXT_INFERRED and keeps the stamp", async () => {
        const named = await epic("named");
        const report = await gatherContext(view({ branch: `fix/${named}` }));
        const handoff = report.current.handoff;
        const reply = await write(
            ctx({ stamp: stampOf(report), inferred: { during: handoff.value, evidence: handoff.how.evidence } }),
            { verb: "spot", title: "x", type: "bug", fields: {} }
        );
        expect(reply.diagnostics.map((d) => d.code)).toContain("CONTEXT_INFERRED");
        const id = reply.ok ? reply.data.items[0].id : "";
        const shown = showItem(db, id);
        expect(shown?.refs.out.find((r) => r.kind === "spotted-in")?.to).toBe(asItemId(named));
        expect(shown?.log[0].stamp?.facts[0]).toMatchObject({ path: "handoff", value: named, method: "inferred" });
    });
});
