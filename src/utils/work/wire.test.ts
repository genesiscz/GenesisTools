import { describe, expect, test } from "bun:test";
import { workMethods } from "./api";
import { callWork, type WorkSession } from "./handlers";
import type { Actor } from "./model/item";
import { type WorkContext, write } from "./service";
import { openWorkDb } from "./store/db";

let n = 0;

function ctx(db: ReturnType<typeof openWorkDb>): WorkContext {
    const actor: Actor = {
        kind: "agent",
        harness: "claude",
        sessionId: "s1",
        sessionTitle: null,
        model: null,
        host: null,
        subagentId: null,
        project: "App",
        repoRoot: null,
        branch: null,
        commitSha: null,
    };
    return {
        db,
        actor,
        project: "App",
        ports: {
            legacy: { write: async () => ({ ok: false }) },
            delivery: { place: async () => null, deliver: async () => ({ outcome: "unknown", to: null, at: "" }) },
        },
        random: () => `x${String(n++).padStart(7, "0")}`,
    };
}

describe("the wire schemas of the read methods match what the handlers return", () => {
    test("list, tree and triage parse with the result schema of the method table", async () => {
        const db = openWorkDb(":memory:");

        try {
            const c = ctx(db);
            await write(c, {
                verb: "spot",
                title: "a bug",
                type: "bug",
                severity: "high",
                fields: { where: "a.ts:1" },
            });
            await write(c, { verb: "add", title: "an epic", type: "epic" });
            const session: WorkSession = {
                ctx: c,
                call: {},
                alive: async () => null,
                context: async () => ({}) as never,
            };

            for (const method of ["list", "tree", "triage"] as const) {
                const reply = await callWork(method, {}, session);
                expect(reply.ok).toBe(true);
                const parsed = workMethods[method].result.safeParse(reply.ok ? reply.data : null);
                expect(parsed.success ? "ok" : `${method}: ${parsed.error.message}`).toBe("ok");
            }
        } finally {
            db.close();
        }
    });
});
