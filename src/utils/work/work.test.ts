import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { claimedHandoffTree, handoffClaimantIds } from "./claimed-handoffs";
import type { ChangeKind } from "./model/change";
import type { Actor } from "./model/item";
import { asItemId } from "./model/item";
import type { ItemState, ItemType } from "./model/vocab";
import type { DeliveryReceipt, LegacyHandoffs, SessionDelivery, SessionPlace } from "./ports";
import { listItems, showItem, triage } from "./read";
import { reopen } from "./reopen";
import { type WorkContext, write } from "./service";
import { applyChange } from "./store/apply";
import { openWorkDb } from "./store/db";

function actor(sessionId: string | null, extra: Partial<Actor> = {}): Actor {
    return {
        kind: "agent",
        harness: "claude",
        sessionId,
        sessionTitle: sessionId ? `session ${sessionId}` : null,
        model: null,
        host: null,
        subagentId: null,
        project: "Proj",
        repoRoot: null,
        branch: null,
        commitSha: null,
        ...extra,
    };
}

const noLegacy: LegacyHandoffs = {
    async write() {
        return { ok: false, error: "no old store in this test" };
    },
    async check(actions) {
        return actions.map(() => ({ ok: true }));
    },
};

function fakeDelivery(
    outcome: DeliveryReceipt["outcome"] | "dead"
): SessionDelivery & { sent: { key: string; text: string }[] } {
    const sent: { key: string; text: string }[] = [];
    return {
        sent,
        async place(): Promise<SessionPlace | null> {
            return outcome === "dead" ? { label: "gone", live: false } : { label: "cmux pane 1", live: true };
        },
        async deliver(input) {
            sent.push({ key: input.key, text: input.text });
            return {
                outcome: outcome === "dead" ? "nobody-alive" : outcome,
                to: null,
                route: "fake",
                at: "2026-11-17T20:00:00.000Z",
            };
        },
    };
}

let db: Database;
let counter = 0;

function ctx(
    sessionId: string | null,
    delivery: SessionDelivery = fakeDelivery("delivered"),
    extra: Partial<Actor> = {}
): WorkContext {
    return {
        db,
        actor: actor(sessionId, extra),
        project: "Proj",
        ports: { legacy: noLegacy, delivery },
        now: () => `2026-11-17T20:${String(counter++ % 60).padStart(2, "0")}:00.000Z`,
        random: () => `${(counter++).toString(36).padStart(8, "0")}`,
    };
}

beforeEach(() => {
    db = openWorkDb(":memory:");
    counter = 0;
});

afterEach(() => {
    db.close();
});

test("claimed handoffs use active local sessions and keep each member slot and its current state", () => {
    const change = (item: string, kind: ChangeKind, payload: unknown, session = "s-a") =>
        applyChange(db, {
            v: 1,
            item: asItemId(item),
            actor: actor(session, { project: "App" }),
            ts: "2026-11-17T20:00:00.000Z",
            origin: { via: "local" },
            kind,
            payload,
        });
    const create = (id: string, type: ItemType, state: ItemState) =>
        change(id, "created", { title: id, project: "App", type, state, tags: [], fields: {} });
    create("pack", "handoff", "active");
    create("empty", "handoff", "reopened");
    create("ended", "handoff", "done");
    create("dropped", "handoff", "dropped");
    create("released", "handoff", "open");
    create("away", "handoff", "open");
    create("unclaimed", "handoff", "open");
    create("epic", "epic", "open");
    create("ship", "task", "active");
    create("check", "bug", "done");
    for (const id of ["pack", "empty", "ended", "dropped", "released", "epic", "ship"]) {
        change(id, "claimed", {});
    }

    change("pack", "claimed", {}, "s-b");
    change("released", "released", {});
    change("away", "claimed", {}, "s-away");
    change("pack", "linked", { kind: "member", to: "check", slot: "t10" });
    change("pack", "linked", { kind: "member", to: "ship", slot: "t2" });
    change("pack", "linked", { kind: "related", to: "away" });

    expect(handoffClaimantIds(db).sort()).toEqual(["s-a", "s-away", "s-b"]);
    expect(claimedHandoffTree(db, new Set())).toEqual([]);
    const live = new Set(["s-a", "s-b"]);
    const tree = claimedHandoffTree(db, live);
    expect(tree.map((handoff) => handoff.id)).toEqual(["empty", "pack"]);
    expect(tree[0].members).toEqual([]);
    expect(tree[1].project).toBe("App");
    expect(tree[1].claimants.map((claim) => claim.sessionId)).toEqual(["s-a", "s-b"]);
    expect(tree[1].members).toEqual([
        { id: "ship", title: "ship", state: "active", slot: "t2" },
        { id: "check", title: "check", state: "done", slot: "t10" },
    ]);

    change("ship", "moved", { from: "active", to: "done" });
    change("pack", "released", {}, "s-a");
    expect(claimedHandoffTree(db, live)[1].members[0].state).toBe("done");
    expect(claimedHandoffTree(db, new Set(["s-a"])).map((handoff) => handoff.id)).toEqual(["empty"]);
});

async function spotted(c: WorkContext, title = "x", extra: Record<string, unknown> = {}): Promise<string> {
    const reply = await write(c, { verb: "spot", title, type: "bug", fields: {}, ...extra });

    if (!reply.ok) {
        throw new Error(reply.diagnostics.map((d) => d.message).join("; "));
    }

    return reply.data.items[0].id;
}

describe("spot", () => {
    test("prints an id and warns once per missing recommended field, with a next action each", async () => {
        const reply = await write(ctx("s1"), { verb: "spot", title: "x", type: "bug", fields: { where: "a.ts:1" } });
        expect(reply.ok).toBe(true);
        const codes = reply.diagnostics.map((d) => `${d.code}:${d.field}`);
        expect(codes).toContain("FIELD_RECOMMENDED:why");
        expect(codes).toContain("FIELD_RECOMMENDED:userSees");
        expect(codes).not.toContain("FIELD_RECOMMENDED:where");
        expect(codes).toContain("CONTEXT_MISSING:during");
        expect(reply.ok && reply.data.items[0].id).toMatch(/^w_[a-z0-9]{8}$/);
        expect(reply.ok && reply.data.items[0].state).toBe("spotted");
        expect(reply.ok && reply.data.items[0].severity).toBeUndefined();
    });

    test("pairs with the caller's one live claim, also from a native subagent of the same session", async () => {
        const lead = ctx("lead-session");
        const handoff = await write(lead, { verb: "add", title: "the handoff", type: "epic" });
        const handoffId = handoff.ok ? handoff.data.items[0].id : "";
        applyChange(db, {
            v: 1,
            ts: "2026-11-17T20:00:00.000Z",
            item: asItemId(handoffId),
            actor: actor("lead-session"),
            kind: "claimed",
            payload: {},
            origin: { via: "local" },
        });

        const sub = ctx("lead-session", fakeDelivery("delivered"), { subagentId: "agent-7" });
        const id = await spotted(sub, "seen by a subagent");
        const listed = listItems(db, { spottedIn: handoffId });
        expect(listed.ok && listed.rows.map((r) => r.ref)).toEqual([id]);
        const shown = showItem(db, id);
        expect(shown?.item.createdBy.subagentId).toBe("agent-7");
    });

    test("pairs a T3 child through the lineage port", async () => {
        const handoff = await write(ctx("parent"), { verb: "add", title: "h", type: "epic" });
        const handoffId = handoff.ok ? handoff.data.items[0].id : "";
        applyChange(db, {
            v: 1,
            ts: "2026-11-17T20:00:00.000Z",
            item: asItemId(handoffId),
            actor: actor("parent"),
            kind: "claimed",
            payload: {},
            origin: { via: "local" },
        });
        const child = ctx("child");
        child.ports.lineage = { leadSessions: async () => ["parent"] };
        const id = await spotted(child);
        expect(showItem(db, id)?.refs.out.find((r) => r.kind === "spotted-in")?.to).toBe(asItemId(handoffId));
    });
});

describe("writes", () => {
    test("a parent is one at most and never a cycle", async () => {
        const c = ctx("s1");
        const a = await spotted(c, "a");
        const b = await spotted(c, "b");
        expect((await write(c, { verb: "edit", ref: b, parent: a })).ok).toBe(true);
        const cycle = await write(c, { verb: "edit", ref: a, parent: b });
        expect(cycle.ok).toBe(false);
        expect(cycle.diagnostics[0].code).toBe("PARENT_CYCLE");
        const d = await spotted(c, "d");
        expect((await write(c, { verb: "edit", ref: b, parent: d })).ok).toBe(true);
        expect(
            showItem(db, b)
                ?.refs.out.filter((r) => r.kind === "parent")
                .map((r) => r.to)
        ).toEqual([asItemId(d)]);
    });

    test("accept, finish, a second finish answers a noop, drop needs a reason", async () => {
        const c = ctx("s1");
        const id = await spotted(c);
        expect((await write(c, { verb: "accept", refs: [id], severity: "high" })).ok).toBe(true);
        expect(showItem(db, id)?.item.state).toBe("open");
        const finish = await write(c, {
            verb: "finish",
            ref: id,
            proof: "bun run test, Mac, abc1234",
            commits: ["abc1234"],
        });
        expect(finish.ok && finish.data.items[0].state).toBe("done");
        expect(showItem(db, id)?.pointers).toEqual([{ kind: "commit", target: "abc1234" }]);
        const again = await write(c, { verb: "finish", ref: id, proof: "again" });
        expect(again.ok && again.data.noop).toBe(true);
        const drop = await write(c, { verb: "drop", refs: [id], why: "" });
        expect(drop.ok).toBe(false);
    });

    test("a request id replays the stored reply and writes nothing more; a dry run writes nothing", async () => {
        const c = ctx("s1");
        const first = await write(c, { verb: "spot", title: "once", type: "idea", fields: {} }, { request: "r1" });
        const second = await write(c, { verb: "spot", title: "once", type: "idea", fields: {} }, { request: "r1" });
        expect(second.receipt?.replayed).toBe(true);
        expect(second.ok ? second.data.items[0].id : "none").toBe(first.ok ? first.data.items[0].id : "first failed");
        const dry = await write(c, { verb: "spot", title: "dry", type: "idea", fields: {} }, { dryRun: true });
        expect(dry.dryRun).toBe(true);
        const all = listItems(db, {});
        expect(all.ok && all.rows.map((r) => r.title)).toEqual(["once"]);
    });

    test("log records an attempt and keeps a measured limit", async () => {
        const c = ctx("s1");
        const id = await spotted(c);
        const reply = await write(c, { verb: "log", ref: id, result: "limit", measured: "42 ranges, 43 target" });
        expect(reply.ok).toBe(true);
        expect(showItem(db, id)?.item.fields.measured).toBe("42 ranges, 43 target");
        expect(showItem(db, id)?.log.some((ch) => ch.kind === "logged")).toBe(true);
    });
});

describe("reopen", () => {
    for (const outcome of ["delivered", "queued", "unknown", "dead"] as const) {
        test(`prints a receipt: ${outcome}`, async () => {
            const delivery = fakeDelivery(outcome);
            const worker = ctx("worker-1", delivery);
            const id = await spotted(worker);
            await write(worker, { verb: "finish", ref: id, proof: "done" });
            const reporter = ctx("reporter", delivery);
            const reply = await reopen(reporter, { ref: id, why: "still broken on the second run" });
            expect(reply.ok).toBe(true);

            if (!reply.ok) {
                return;
            }

            expect(reply.data.item.state).toBe("reopened");
            expect(reply.data.worker?.sessionId).toBe("worker-1");
            expect(reply.data.receipt?.outcome).toBe(outcome === "dead" ? "nobody-alive" : outcome);
            expect(delivery.sent.length).toBe(outcome === "dead" ? 0 : 1);

            if (outcome === "dead") {
                expect(reply.next.length).toBe(3);
            } else {
                expect(delivery.sent[0].key).toMatch(new RegExp(`^work-reopen:${id}:\\d+$`));
            }

            expect(showItem(db, id)?.log.some((ch) => ch.kind === "delivered")).toBe(true);
        });
    }

    test("a repeat with the same request id never sends again", async () => {
        const delivery = fakeDelivery("unknown");
        const worker = ctx("worker-1", delivery);
        const id = await spotted(worker);
        await write(worker, { verb: "finish", ref: id, proof: "done" });
        await reopen(ctx("reporter", delivery), { ref: id, why: "w", request: "rq" });
        const again = await reopen(ctx("reporter", delivery), { ref: id, why: "w", request: "rq" });
        expect(again.receipt?.replayed).toBe(true);
        expect(delivery.sent.length).toBe(1);
    });
});

describe("triage", () => {
    test("groups spotted items and items whose worker is gone, each with next actions", async () => {
        const c = ctx("s1");
        const a = await spotted(c, "seen", { fields: { where: "a.ts:3", why: "w", userSees: "u" } });
        const b = await spotted(c, "worked");
        await write(c, { verb: "finish", ref: b, proof: "p" });
        await reopen(ctx("reporter", fakeDelivery("dead")), { ref: b, why: "no" });
        const rows = await triage(db, "Proj", async () => false);
        const byRef = new Map(rows.map((r) => [r.ref, r]));
        expect(byRef.get(a)?.group).toBe("spotted");
        expect(byRef.get(a)?.where).toBe("a.ts:3");
        expect(byRef.get(a)?.next.map((n) => n.call?.method)).toEqual(["accept", "drop", "add", "handoff"]);
        expect(byRef.get(b)?.group).toBe("reopened-no-worker");
    });
});
