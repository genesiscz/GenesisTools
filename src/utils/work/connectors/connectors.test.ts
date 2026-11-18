import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { makeTempDir } from "@genesiscz/utils/paths";
import { z } from "zod";
import { callWork, type WorkSession } from "../handlers";
import type { Actor, ItemId } from "../model/item";
import { asItemId } from "../model/item";
import { projectCounts } from "../read";
import { projectRuleLoader, setWorkConfigValue } from "../rules/load";
import { type WorkContext, write } from "../service";
import { openWorkDb } from "../store/db";
import { selectItem, selectPairings } from "../store/rows";
import { connectorConfigOf } from "./config";
import { pullRemote, releaseHeld, runSyncOnce, type SyncDeps } from "./sync";
import type { Connector, ConnectorContext, PushIntent, RemoteItem } from "./types";

let db: Database;
let configPath: string;
let n = 0;

function actor(sessionId: string, kind: Actor["kind"] = "agent"): Actor {
    return {
        kind,
        harness: "claude",
        sessionId,
        sessionTitle: null,
        model: null,
        host: null,
        subagentId: null,
        project: "App",
        repoRoot: null,
        branch: null,
        commitSha: null,
    };
}

function ctx(sessionId: string, kind: Actor["kind"] = "agent"): WorkContext {
    return {
        db,
        actor: actor(sessionId, kind),
        project: "App",
        ports: {
            legacy: { write: async () => ({ ok: false }), check: async (actions) => actions.map(() => ({ ok: true })) },
            delivery: { place: async () => null, deliver: async () => ({ outcome: "unknown", to: null, at: "" }) },
        },
        random: () => `f${String(n++).padStart(7, "0")}`,
    };
}

class FakeConnector implements Connector<unknown> {
    readonly id = "fake";
    readonly settings = z.unknown();
    readonly can = { create: true, pull: true, labels: true, comments: false, parents: false };
    pushed: PushIntent[] = [];
    batches: { context: ConnectorContext; titles: string[] }[] = [];
    pulls: ConnectorContext[] = [];
    remote = new Map<string, RemoteItem>();

    async status() {
        return { ok: true, detail: "fake" };
    }

    async push(intents: readonly PushIntent[], context: ConnectorContext) {
        this.batches.push({ context, titles: intents.map(({ item }) => item.title) });
        this.pushed.push(...intents);
        return intents.map((intent) => {
            const key = intent.pairing?.remoteKey || `R-${intent.item.id}`;
            this.remote.set(key, {
                remoteKey: key,
                title: intent.item.title,
                state: intent.item.state,
                labels: intent.labels,
            });
            return { ok: true as const, remoteKey: key };
        });
    }

    async pull(ask: { remoteKeys: readonly string[] }, context: ConnectorContext) {
        this.pulls.push(context);
        return ask.remoteKeys.map((key) => this.remote.get(key)).filter((r): r is RemoteItem => r !== undefined);
    }
}

let fake: FakeConnector;

function deps(): SyncDeps & { newId: () => ItemId; project: string } {
    return {
        db,
        connectors: { fake },
        loadRules: projectRuleLoader({ project: "App", configPath }),
        machinePrefix: "m-",
        now: () => new Date().toISOString(),
        owner: "test",
        newId: () => asItemId(`w_p${String(n++).padStart(7, "0")}`),
        project: "App",
    };
}

beforeEach(async () => {
    db = openWorkDb(":memory:");
    fake = new FakeConnector();
    configPath = join(makeTempDir("work-connectors-"), "config.json");
    const set = await setWorkConfigValue({
        configPath,
        path: "global.rules.connectors.fake",
        value: { enabled: true, createTypes: ["bug", "epic"] },
    });
    expect(set.ok).toBe(true);
});

afterEach(() => {
    db.close();
});

async function spot(sessionId: string, type: "bug" | "epic" | "task", title = "x"): Promise<ItemId> {
    const reply = await write(ctx(sessionId), { verb: "spot", title, type, fields: {} });
    return reply.ok ? reply.data.items[0].id : asItemId("none");
}

describe("the sync consumer", () => {
    test("a pass from App loads each project once and pushes each batch with that project's settings", async () => {
        for (const [project, type] of [
            ["App", "bug"],
            ["Other", "task"],
        ]) {
            const set = await setWorkConfigValue({
                configPath,
                path: `projects.${project}.rules.connectors.fake`,
                value: { settings: { target: project }, createTypes: [type], labelTemplate: `${project}/{id}` },
            });
            expect(set.ok).toBe(true);
        }

        const app = ctx("s1");
        const other = { ...app, project: "Other" };
        await write(app, { verb: "spot", type: "bug", title: "app bug", fields: {} });
        await write(other, { verb: "spot", type: "bug", title: "local only", fields: {} });
        await write(other, { verb: "spot", type: "task", title: "first task", fields: {} });
        await write(other, { verb: "spot", type: "task", title: "second task", fields: {} });
        const sync = deps();
        const loads: string[] = [];
        const report = await runSyncOnce({
            ...sync,
            loadRules: (location) => {
                loads.push(location.project);
                return sync.loadRules(location);
            },
        });
        expect(report.pushed).toBe(3);
        expect(loads).toEqual(["App", "Other"]);
        expect(fake.batches).toEqual([
            { context: { project: "App", settings: { target: "App" }, machinePrefix: "m-" }, titles: ["app bug"] },
            {
                context: { project: "Other", settings: { target: "Other" }, machinePrefix: "m-" },
                titles: ["first task", "second task"],
            },
        ]);
        for (const { item, labels } of fake.pushed) {
            expect(labels).toEqual([`${item.project}/${item.id}`]);
        }
    });

    test("a pull in Other can use the same outside key as App without updating App's item", async () => {
        const sync = deps();
        fake.remote.set("R-1", { remoteKey: "R-1", title: "app task" });
        const app = await pullRemote(sync, "fake", ["R-1"]);
        const set = await setWorkConfigValue({
            configPath,
            path: "projects.Other.rules.connectors.fake.settings",
            value: { target: "Other" },
        });
        expect(set.ok).toBe(true);

        fake.remote.set("R-1", { remoteKey: "R-1", title: "other task" });
        const other = await pullRemote({ ...sync, project: "Other" }, "fake", ["R-1"]);
        expect(other.made).toHaveLength(1);
        expect(selectItem(db, other.made[0])).toMatchObject({ title: "other task", project: "Other" });
        expect(selectItem(db, app.made[0])).toMatchObject({ title: "app task", project: "App" });
        expect(fake.pulls.at(-1)).toMatchObject({ project: "Other", settings: { target: "Other" } });
    });

    test("a write never calls the connector; the consumer pushes after it, with the label, and a repeat pushes nothing new", async () => {
        const id = await spot("s1", "bug");
        expect(fake.pushed).toHaveLength(0);

        const first = await runSyncOnce(deps());
        expect(first.pushed).toBe(1);
        expect(fake.pushed[0].labels).toEqual([`gt/pm/m-App/${id}`]);
        expect(selectPairings(db, { item: id })[0]).toMatchObject({
            remoteKey: `R-${id}`,
            state: "in-sync",
            born: "local",
        });

        const again = await runSyncOnce(deps());
        expect(again.pushed).toBe(0);
        expect(fake.pushed).toHaveLength(1);
    });

    test("a change by a role that may not push is held, and a release pushes it", async () => {
        const epic = await write(ctx("owner-s", "owner"), { verb: "add", title: "big", type: "epic" });
        const id = epic.ok ? epic.data.items[0].id : asItemId("none");
        await runSyncOnce(deps());
        expect(selectPairings(db, { item: id })[0].state).toBe("in-sync");

        await write(ctx("other"), { verb: "comment", ref: id, text: "a note" });
        const report = await runSyncOnce(deps());
        expect(report.held).toBe(1);
        expect(selectPairings(db, { item: id })[0].state).toBe("held");

        const released = await releaseHeld(deps(), id);
        expect(released.pushed).toBe(1);
        expect(selectPairings(db, { item: id })[0].state).toBe("in-sync");
    });

    test("a pull makes an unknown outside item a local one born outside; a change of a local fact is drift, never applied", async () => {
        fake.remote.set("R-9", { remoteKey: "R-9", title: "from outside", state: "open" });
        const made = await pullRemote(deps(), "fake", ["R-9"]);
        const local = made.made[0];
        expect(selectItem(db, local)?.title).toBe("from outside");
        expect(selectPairings(db, { item: local })[0]).toMatchObject({ born: "remote", remoteKey: "R-9" });

        fake.remote.set("R-9", { remoteKey: "R-9", title: "renamed outside", state: "done" });
        const second = await pullRemote(deps(), "fake", ["R-9"]);
        expect(second.updated).toEqual([local]);
        expect(second.drift).toEqual([local]);
        expect(selectItem(db, local)?.title).toBe("renamed outside");
        expect(selectItem(db, local)?.state).toBe("open");
        expect(selectPairings(db, { item: local })[0]).toMatchObject({ state: "drift" });
    });
});

describe("drift in the other direction", () => {
    test("a local edit of a fact the outside owns is not pushed and marks the pairing drift", async () => {
        fake.remote.set("R-5", { remoteKey: "R-5", title: "made outside", state: "open" });
        const made = await pullRemote(deps(), "fake", ["R-5"]);
        const id = made.made[0];
        await runSyncOnce(deps());
        await write(ctx("s1"), { verb: "edit", ref: id, title: "renamed here" });
        const report = await runSyncOnce(deps());
        expect(report.drift).toBe(1);
        expect(selectPairings(db, { item: id })[0]).toMatchObject({ state: "drift" });
        expect(selectPairings(db, { item: id })[0].note).toContain("title");
    });
});

describe("the connector config", () => {
    test("a later layer wins key by key; settings and push merge; an unnamed connector is null", () => {
        const { config } = connectorConfigOf(
            [
                { layer: "config.global", rules: { connectors: { fake: { enabled: true, settings: { a: 1 } } } } },
                {
                    layer: "config.project",
                    rules: {
                        connectors: { fake: { settings: { b: 2 }, createTypes: ["bug"], push: { bug: ["owner"] } } },
                    },
                },
            ],
            "fake"
        );
        expect(config?.enabled).toBe(true);
        expect(config?.settings).toEqual({ a: 1, b: 2 });
        expect(config?.createTypes).toEqual(["bug"]);
        expect(config?.push("bug")).toEqual(["owner"]);
        expect(config?.push("task")).toBeUndefined();
        expect(connectorConfigOf([], "fake").config).toBeNull();
    });
});

describe("the connector methods", () => {
    function session(withPort: boolean): WorkSession {
        const base = ctx("s1");
        return {
            ctx: withPort ? { ...base, ports: { ...base.ports, connectors: { syncDeps: () => deps() } } } : base,
            call: {},
            alive: async () => null,
            context: async () => {
                throw new Error("not used");
            },
        };
    }

    test("pair records the pairing and pushes the label at once; unpair removes it; sync runs one pass", async () => {
        const id = await spot("s1", "task");
        const paired = await callWork("pair", { ref: id, connector: "fake", key: "R-77" }, session(true));
        expect(paired.ok).toBe(true);
        expect(fake.pushed.map((p) => p.labels)).toEqual([[`gt/pm/m-App/${id}`]]);
        expect(selectPairings(db, { item: id })[0]).toMatchObject({ remoteKey: "R-77", state: "in-sync" });

        const sync = await callWork("sync", {}, session(true));
        expect(sync.ok && sync.data).toMatchObject({ failed: 0 });

        const removed = await callWork("unpair", { ref: id, connector: "fake" }, session(true));
        expect(removed.ok && removed.data).toEqual({ removed: true });
        expect(selectPairings(db, { item: id })).toHaveLength(0);
    });

    test("a door with no connectors, an unknown connector and an unknown item are refused", async () => {
        const id = await spot("s1", "task");
        const none = await callWork("sync", {}, session(false));
        expect(none.ok ? "" : none.diagnostics[0].code).toBe("CONNECTORS_MISSING");
        const unknown = await callWork("pull", { connector: "nope", keys: ["1"] }, session(true));
        expect(unknown.ok ? "" : unknown.diagnostics[0].code).toBe("UNKNOWN_CONNECTOR");
        const missing = await callWork("pair", { ref: "w_missing0", connector: "fake", key: "1" }, session(true));
        expect(missing.ok ? "" : missing.diagnostics[0].code).toBe("NOT_FOUND");
        expect(id).toMatch(/^w_/);
    });
});

describe("the counts per project (P8)", () => {
    test("spotted, reopened and held count per project; a project with nothing is left out", async () => {
        await spot("s1", "bug");
        await spot("s1", "bug");
        const epic = await write(ctx("owner-s", "owner"), { verb: "add", title: "big", type: "epic" });
        const id = epic.ok ? epic.data.items[0].id : asItemId("none");
        await runSyncOnce(deps());
        await write(ctx("other"), { verb: "comment", ref: id, text: "a note" });
        await runSyncOnce(deps());
        expect(projectCounts(db)).toEqual([{ project: "App", spotted: 2, reopened: 0, held: 1 }]);
    });
});
