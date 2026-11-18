import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { executeHandoffActions, getHandoff, type HandoffDeps, postHandoff } from "@app/handoff/executor";
import { byFor, freshEnv, type TestEnv } from "@app/handoff/test-utils";
import { makeTempDir } from "@genesiscz/utils/paths";
import { parityOf } from "@genesiscz/utils/work/legacy/shadow";
import type { Actor } from "@genesiscz/utils/work/model/item";
import type { SessionDelivery } from "@genesiscz/utils/work/ports";
import { listItems, showItem } from "@genesiscz/utils/work/read";
import { reopen } from "@genesiscz/utils/work/reopen";
import { projectRuleLoader, setWorkConfigValue } from "@genesiscz/utils/work/rules/load";
import { type WorkContext, write } from "@genesiscz/utils/work/service";
import { openWorkDb } from "@genesiscz/utils/work/store/db";
import { journalHead } from "@genesiscz/utils/work/store/rows";
import { legacyHandoffs } from "./adapters";
import { ownerAtSurface } from "./adapters/actor";
import { openLegacySource } from "./adapters/legacy-source";
import { connectorPort, syncNeededAfter } from "./connectors";

const actor: Actor = {
    kind: "agent",
    harness: "claude-code",
    sessionId: "sess-a",
    sessionTitle: "session a",
    model: null,
    host: null,
    subagentId: null,
    project: "TestProj",
    repoRoot: null,
    branch: null,
    commitSha: null,
};

const delivery: SessionDelivery = {
    async place() {
        return { label: "pane", live: true };
    },
    async deliver() {
        return { outcome: "delivered", to: null, at: "2026-11-17T20:00:00.000Z" };
    },
};

let env: TestEnv;
let deps: HandoffDeps;
let db: Database;

function ctx(over: HandoffDeps = deps): WorkContext {
    return { db, actor, project: "TestProj", ports: { legacy: legacyHandoffs(over), delivery } };
}

function parity(): string[] {
    const source = openLegacySource({ catchUp: false, dbPath: env.dbPath });

    try {
        return source
            .handoffs()
            .flatMap((h) => parityOf(db, h).map((d) => `${d.handoff}${d.slot ? `:${d.slot}` : ""} ${d.what}`));
    } finally {
        source.close();
    }
}

beforeEach(() => {
    env = freshEnv();
    deps = env.depsFor(byFor("sess-a", "session a"));
    db = openWorkDb(env.dbPath);
});

afterEach(() => {
    db.close();
});

async function spot(title: string): Promise<string> {
    const reply = await write(ctx(), { verb: "spot", title, type: "bug", fields: {} });
    return reply.ok ? reply.data.items[0].id : "";
}

test("an App write schedules sync when it changes an item in Other with a connector enabled", async () => {
    const configPath = join(makeTempDir("work-sync-"), "config.json");
    const set = await setWorkConfigValue({
        configPath,
        path: "projects.Other.rules.connectors.reminders.enabled",
        value: true,
    });
    expect(set.ok).toBe(true);
    const app = { ...ctx(), project: "App", actor: { ...actor, project: "App" } };
    const other = await write({ ...app, project: "Other" }, { verb: "add", type: "task", title: "other task" });

    if (!other.ok) {
        throw new Error("could not create the task in Other");
    }

    const loadRules = projectRuleLoader({ project: "App", configPath });
    const sync = connectorPort(db, loadRules).syncDeps();
    const seq = journalHead(db);
    await write(app, { verb: "spot", type: "bug", title: "app bug", fields: {} });
    expect(await syncNeededAfter({ ...sync, seq })).toBe(false);
    await write(app, { verb: "comment", ref: other.data.items[0].id, text: "changed from App" });
    expect(await syncNeededAfter({ ...sync, seq })).toBe(true);
});

describe("one store (P6)", () => {
    test("a post and a tick fold the handoff and its items in one write; parity holds", () => {
        const posted = postHandoff({ title: "h", tasks: [{ text: "one" }, { text: "two" }] }, deps);
        const id = posted.handoff.id;
        executeHandoffActions(
            {
                id,
                actions: [
                    "claim",
                    { action: "check_task", taskId: "t1", proof: { answer: "ok", commitIds: ["abc1234"] } },
                ],
            },
            deps
        );

        expect(showItem(db, id)?.item.state).toBe("active");
        expect(showItem(db, `${id}:t1`)?.item.state).toBe("done");
        expect(showItem(db, `${id}:t2`)?.item.state).toBe("open");
        const members = listItems(db, { under: id });
        expect(members.ok && members.rows.map((r) => r.slot)).toEqual(["t1", "t2"]);
        expect(parity()).toEqual([]);
    });

    test("handoff --from gives one handoff and keeps two items", async () => {
        const a = await spot("first");
        const b = await spot("second");
        const reply = await write(ctx(), { verb: "handoff", title: "follow-up", from: [a, b] });
        expect(reply.ok).toBe(true);
        const handoff = reply.ok ? (reply.data.handoff ?? "") : "";
        expect(handoff).toMatch(/^h_/);

        const work = listItems(db, { types: ["bug", "task"] });
        expect(work.ok && work.rows.map((r) => r.ref).sort()).toEqual([a, b].sort());
        const members = listItems(db, { under: handoff });
        expect(members.ok && members.rows.map((r) => r.ref)).toEqual([a, b]);
        expect(getHandoff({ id: handoff }, deps).handoff.tasks.map((t) => t.text)).toEqual(["first", "second"]);
        expect(parity()).toEqual([]);
    });

    test("finish and reopen of a member go through the old log and come back through the hook", async () => {
        const a = await spot("member");
        const made = await write(ctx(), { verb: "handoff", title: "h", from: [a] });
        const handoff = made.ok ? (made.data.handoff ?? "") : "";

        const finished = await write(ctx(), {
            verb: "finish",
            ref: `${handoff}:t1`,
            proof: "bun run test, Mac, abc1234",
        });
        expect(finished.ok && finished.data.items[0].state).toBe("done");
        expect(getHandoff({ id: handoff }, deps).handoff.tasks[0].checked).toBe(true);

        const reopened = await reopen(ctx(), { ref: a, why: "still wrong" });
        expect(reopened.ok && reopened.data.item.state).toBe("reopened");
        expect(reopened.ok && reopened.data.receipt?.outcome).toBe("delivered");
        expect(getHandoff({ id: handoff }, deps).handoff.tasks[0].checked).toBe(false);
        expect(
            showItem(db, a)?.log.some(
                (c) => c.kind === "commented" && String((c.payload as { text: string }).text).includes("still wrong")
            )
        ).toBe(true);
        expect(parity()).toEqual([]);
    });
});

describe("doors", () => {
    test("work_spot and work_list answer through the MCP tool group, and work.list through the REPL toolset", async () => {
        const { toolGroup } = await import("./mcp/genesis-tools");
        const group = toolGroup();
        expect(Object.keys(group.entries).sort()).toEqual([
            "work_context",
            "work_list",
            "work_reopen",
            "work_show",
            "work_spot",
            "work_write",
        ]);
        const spotted = await group.entries.work_spot.handler({
            title: "seen through mcp",
            type: "bug",
            during: "none",
        });
        expect(typeof spotted === "string" ? spotted : spotted.text).toContain("NOT_FOUND");
        const listed = await group.entries.work_list.handler({ type: ["bug"] });
        expect(typeof listed === "string" ? listed : listed.structuredContent).toMatchObject({
            ok: true,
            verb: "list",
        });

        const { WorkToolset } = await import("@app/node-repl/lib/toolsets/work");
        const globals = await new WorkToolset().bootstrap();
        const work = globals.work as Record<
            string,
            (p: Record<string, unknown>) => Promise<{ ok: boolean; verb: string }>
        >;
        expect(await work.list({ limit: 1 })).toMatchObject({ ok: true, verb: "list" });
    });
});

describe("add-member (P5 decision 5)", () => {
    test("an item becomes one more task of an open handoff; a second add changes nothing; a non-handoff target is refused", async () => {
        const posted = postHandoff({ title: "h", tasks: [{ text: "one" }] }, deps);
        const handoff = posted.handoff.id;
        const a = await spot("joins the handoff");
        const reply = await write(ctx(), { verb: "add-member", refs: [a], to: handoff });
        expect(reply.ok).toBe(true);
        expect(getHandoff({ id: handoff }, deps).handoff.tasks.map((t) => t.text)).toEqual([
            "one",
            "joins the handoff",
        ]);
        const members = listItems(db, { under: handoff });
        expect(members.ok && members.rows.map((r) => r.ref)).toContain(a);
        expect(showItem(db, a)?.item.state).toBe("open");

        const again = await write(ctx(), { verb: "add-member", refs: [a], to: handoff });
        expect(again.ok).toBe(true);
        expect(getHandoff({ id: handoff }, deps).handoff.tasks).toHaveLength(2);

        const refused = await write(ctx(), { verb: "add-member", refs: [a], to: a });
        expect(refused.ok ? "" : refused.diagnostics[0].code).toBe("NOT_A_HANDOFF");
        expect(parity()).toEqual([]);
    });

    test("an agent's add to a handoff another session posted is refused before the store writes; the owner's add passes", async () => {
        const posted = postHandoff({ title: "theirs", tasks: [{ text: "one" }] }, env.depsFor(byFor("sess-b", "b")));
        const handoff = posted.handoff.id;
        const a = await spot("the owner moves it in");
        const journal = (): number => (db.query("SELECT COUNT(*) AS n FROM changes").get() as { n: number }).n;
        const before = journal();
        const agent = await write(ctx(), { verb: "add-member", refs: [a], to: handoff });
        expect(agent.ok ? "" : agent.diagnostics.map((d) => d.code).join()).toBe("LEGACY_REFUSED");
        expect(showItem(db, a)?.item.state).toBe("spotted");
        expect(journal()).toBe(before);
        expect(getHandoff({ id: handoff }, deps).handoff.tasks.map((t) => t.text)).toEqual(["one"]);

        const owner = { ...ctx(), actor: ownerAtSurface("TestProj", "hub").actor };
        const b = await spot("the owner moves this one in");
        const reply = await write(owner, { verb: "add-member", refs: [b], to: handoff });
        expect(reply.ok ? "ok" : reply.diagnostics.map((d) => d.message).join()).toBe("ok");
        expect(getHandoff({ id: handoff }, deps).handoff.tasks.map((t) => t.text)).toContain(
            "the owner moves this one in"
        );
    });
});
