import { describe, expect, test } from "bun:test";
import { SafeJSON } from "@genesiscz/utils/json";
import type { Reply } from "@genesiscz/utils/output/reply";
import { workMethods } from "./api";
import { originFor, type Pairing } from "./connectors/types";
import { callWork, type WorkSession } from "./handlers";
import { mirrorSessionTodos } from "./legacy/session-todos";
import type { Actor } from "./model/item";
import { resolveWorkRules } from "./rules/resolve";
import { type WorkContext, write } from "./service";
import { applyChange } from "./store/apply";
import { openWorkDb } from "./store/db";
import type { WorkCommand } from "./store/decide";

let n = 0;

function data<T>(reply: Reply<T>): T {
    if (!reply.ok) {
        throw new Error(reply.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
    }

    return reply.data;
}

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
            legacy: { write: async () => ({ ok: false }), check: async (actions) => actions.map(() => ({ ok: true })) },
            delivery: { place: async () => null, deliver: async () => ({ outcome: "unknown", to: null, at: "" }) },
        },
        random: () => `x${String(n++).padStart(7, "0")}`,
    };
}

function recordPairing(
    ctx: WorkContext,
    row: Pick<Pairing, "item" | "connector" | "remoteKey" | "state" | "note"> & { born?: Pairing["born"] }
) {
    const born = row.born ?? "local";
    const ts = "2026-01-01T00:00:00.000Z";
    const pairing: Pairing = { ...row, born, origin: originFor(born), updatedTs: ts };
    applyChange(ctx.db, {
        v: 1,
        ts,
        item: row.item,
        kind: "paired",
        actor: ctx.actor,
        origin: { via: "connector", id: row.connector },
        payload: { pairing },
    });
}

describe("the wire schemas of the read methods match what the handlers return", () => {
    test("list pages across the 5000-row boundary with stable ordering for tied timestamps", async () => {
        const db = openWorkDb(":memory:");
        try {
            const fixture = ctx(db);
            const ts = "2026-11-19T06:00:00.000Z";
            db.run(
                `WITH RECURSIVE numbers(i) AS (VALUES(0) UNION ALL SELECT i + 1 FROM numbers WHERE i < 5000)
                 INSERT INTO items (id, type, state, project, rev, title, created_by, created_ts, updated_ts)
                 SELECT printf('w_%08d', i), 'task', 'done', 'App', 1, 'Closed fixture', ?, ?, ? FROM numbers`,
                [SafeJSON.stringify(fixture.actor), ts, ts]
            );
            const session: WorkSession = {
                ctx: fixture,
                call: {},
                alive: async () => null,
                context: async () => {
                    throw new Error("Unexpected request for context");
                },
            };
            const params = { project: "App", fields: ["ref"], limit: 5000 };
            const first = workMethods.list.result.parse(data(await callWork("list", params, session)));
            expect(first).toHaveLength(5000);
            expect(data(await callWork("list", { ...params, after: first.at(-1)?.ref }, session))).toEqual([
                { ref: "w_00005000" },
            ]);
        } finally {
            db.close();
        }
    });
    test("show resolves old session-task IDs through the Work door before and after import", async () => {
        const db = openWorkDb(":memory:");
        try {
            const row = {
                id: "t_1_fixture",
                sessionId: "fixture",
                number: 1,
                prompt: "Check the export",
                state: "implemented",
                project: "Orchard",
                updatedTs: "2026-11-19T06:00:00.000Z",
            };
            const session: WorkSession = {
                ctx: ctx(db),
                call: {},
                alive: async () => null,
                context: async () => {
                    throw new Error("Unexpected request for context");
                },
                legacySessionTodo: (ref) => (ref === row.id ? row : undefined),
            };

            expect(data(await callWork("show", { ref: row.id }, session))).toMatchObject({
                item: { id: row.id, state: "done", title: row.prompt, project: "Orchard" },
                log: [],
            });
            mirrorSessionTodos(db, [row], () => "fixture1");
            expect(data(await callWork("show", { ref: row.id }, session))).toMatchObject({
                item: { id: "w_fixture1", state: "done" },
                log: [{ kind: "created" }, { kind: "pointed" }],
            });
        } finally {
            db.close();
        }
    });
    test("list, tree and triage parse with the result schema of the method table", async () => {
        const db = openWorkDb(":memory:");

        try {
            const c = ctx(db);
            c.rules = resolveWorkRules([
                {
                    layer: "config.project",
                    rules: { connectors: { tracker: { enabled: true, settings: { server: "Issue desk" } } } },
                },
            ]);
            const create = async (command: WorkCommand) => data(await write(c, command)).items[0].id;
            const bug = await create({
                verb: "spot",
                title: "a bug",
                type: "bug",
                severity: "high",
                fields: { where: "a.ts:1" },
            });
            const epic = await create({ verb: "add", title: "an epic", type: "epic" });
            const task = await create({ verb: "add", title: "a member", type: "task", parent: epic });
            const unpaired = await create({ verb: "spot", title: "unpaired", type: "bug", fields: {} });
            recordPairing(c, { item: epic, connector: "tracker", remoteKey: "EP-1", state: "in-sync" });
            recordPairing(c, {
                item: task,
                connector: "tracker",
                remoteKey: "TK-2",
                born: "remote",
                state: "drift",
                note: "changed here, owned outside: title",
            });
            recordPairing(c, {
                item: bug,
                connector: "tracker",
                remoteKey: "BG-3",
                state: "drift",
                note: "changed outside, owned here: state",
            });
            recordPairing(c, { item: bug, connector: "mirror", remoteKey: "M-4", state: "held" });
            const session: WorkSession = {
                ctx: c,
                call: {},
                alive: async () => null,
                context: async () => {
                    throw new Error("A read of the store should not need session context");
                },
            };

            for (const method of ["list", "config"] as const) {
                const reply = await callWork(method, {}, session);
                expect(reply.ok).toBe(true);
                const parsed = workMethods[method].result.safeParse(reply.ok ? reply.data : null);
                expect(parsed.success ? "ok" : `${method}: ${parsed.error.message}`).toBe("ok");
            }

            // A property missing from the schema gets stripped on the way to Swift.
            const tree = workMethods.tree.result.parse(data(await callWork("tree", {}, session)));
            expect(tree.containers).toHaveLength(1);
            expect(tree.containers[0].pairings).toEqual([
                { connector: "tracker", displayName: "Issue desk", enabled: true, remoteKey: "EP-1", state: "in-sync" },
            ]);
            expect(tree.containers[0].members[0].pairings).toEqual([
                {
                    connector: "tracker",
                    displayName: "Issue desk",
                    enabled: true,
                    remoteKey: "TK-2",
                    state: "drift",
                    driftDirection: "local",
                    note: "changed here, owned outside: title",
                },
            ]);
            const rows = workMethods.triage.result.parse(data(await callWork("triage", {}, session)));
            expect(rows.find((row) => row.ref === bug)?.pairings).toEqual([
                { connector: "mirror", enabled: false, remoteKey: "M-4", state: "held" },
                {
                    connector: "tracker",
                    displayName: "Issue desk",
                    enabled: true,
                    remoteKey: "BG-3",
                    state: "drift",
                    driftDirection: "remote",
                    note: "changed outside, owned here: state",
                },
            ]);
            const plainRow = rows.find((row) => row.ref === unpaired);
            expect(plainRow).toBeDefined();
            expect(plainRow).not.toHaveProperty("pairings");
        } finally {
            db.close();
        }
    });
});
