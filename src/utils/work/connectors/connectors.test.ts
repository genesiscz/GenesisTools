import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import { callWork, type WorkSession } from "../handlers";
import type { Actor, ItemId } from "../model/item";
import { asItemId } from "../model/item";
import { type WorkContext, write } from "../service";
import { openWorkDb } from "../store/db";
import { selectItem, selectPairings } from "../store/rows";
import { connectorConfigOf } from "./config";
import { type ConnectorConfig, pullRemote, releaseHeld, runSyncOnce, type SyncDeps } from "./sync";
import type { Connector, PushIntent, RemoteItem } from "./types";

let db: Database;
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
            legacy: { write: async () => ({ ok: false }) },
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
    remote = new Map<string, RemoteItem>();

    async status() {
        return { ok: true, detail: "fake" };
    }

    async push(intents: readonly PushIntent[]) {
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

    async pull(ask: { remoteKeys: readonly string[] }) {
        return ask.remoteKeys.map((key) => this.remote.get(key)).filter((r): r is RemoteItem => r !== undefined);
    }
}

let fake: FakeConnector;

function deps(): SyncDeps & { newId: () => ItemId; project: string } {
    const config: ConnectorConfig = {
        enabled: true,
        settings: {},
        labelTemplate: "gt/pm/{machine}{project}/{id}",
        createTypes: ["bug", "epic"],
        push: () => undefined,
    };
    return {
        db,
        connectors: { fake },
        config: () => config,
        machinePrefix: "m-",
        now: () => new Date().toISOString(),
        owner: "test",
        newId: () => asItemId(`w_p${String(n++).padStart(7, "0")}`),
        project: "App",
    };
}

beforeEach(() => {
    db = openWorkDb(":memory:");
    fake = new FakeConnector();
});

afterEach(() => {
    db.close();
});

async function spot(sessionId: string, type: "bug" | "epic" | "task", title = "x"): Promise<ItemId> {
    const reply = await write(ctx(sessionId), { verb: "spot", title, type, fields: {} });
    return reply.ok ? reply.data.items[0].id : asItemId("none");
}

describe("the sync consumer", () => {
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
