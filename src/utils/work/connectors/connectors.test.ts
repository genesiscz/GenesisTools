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
import { applyChange } from "../store/apply";
import { openWorkDb } from "../store/db";
import { selectItem, selectPairings } from "../store/rows";
import { sqlView } from "../store/view";
import { connectorConfigOf } from "./config";
import { outOfScope } from "./scope";
import {
    noteStandingDrift,
    previewSync,
    pullRemote,
    releaseHeld,
    resolveDrift,
    runSyncOnce,
    type SyncDeps,
} from "./sync";
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
    can = { create: true, pull: true, labels: true, comments: false, parents: false, links: false };
    pushed: PushIntent[] = [];
    unavailable = false;
    failure = "temporarily unavailable";
    batches: { context: ConnectorContext; titles: string[] }[] = [];
    keptAlive: (boolean | undefined)[] = [];
    /** Titles edited outside by key; a push leaves them unless forced, as the tracker does. */
    editedOutside = new Map<string, string>();
    pulls: ConnectorContext[] = [];
    remote = new Map<string, RemoteItem>();

    async status() {
        return { ok: true, detail: "fake" };
    }

    async push(intents: readonly PushIntent[], context: ConnectorContext) {
        this.batches.push({ context, titles: intents.map(({ item }) => item.title) });
        this.keptAlive.push(context.keepAlive?.());
        this.pushed.push(...intents);

        if (this.unavailable) {
            return intents.map(() => ({ ok: false as const, error: this.failure }));
        }

        return intents.map((intent) => {
            const key = intent.pairing?.remoteKey || `R-${intent.item.id}`;
            const prior = this.remote.get(key);
            const outside = this.editedOutside.get(key);

            if (outside !== undefined && outside !== intent.item.title && !intent.force?.includes("title")) {
                return {
                    ok: true as const,
                    remoteKey: key,
                    sent: {},
                    changedOutside: [{ fact: "title" as const, outside, here: intent.item.title }],
                };
            }

            this.editedOutside.delete(key);
            this.remote.set(key, {
                remoteKey: key,
                title: intent.pairing?.origin.title === "remote" ? prior?.title : intent.item.title,
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

describe("review regressions", () => {
    test("a scope includes a root more than 64 ancestors away", async () => {
        const root = await spot("s1", "bug", "root");
        let parent = root;
        for (let depth = 0; depth < 66; depth++) {
            const child = await spot("s1", "bug", `child ${depth}`);
            expect((await write(ctx("s1"), { verb: "edit", ref: child, parent })).ok).toBe(true);
            parent = child;
        }
        expect(
            outOfScope(sqlView(db), selectItem(db, parent)!, { handoffTasks: true, under: [root], tags: [] })
        ).toBeNull();
    });

    test("quiet --all updates existing pairings only on their own connector", async () => {
        const id = await spot("s1", "bug", "one connector");
        await runSyncOnce(deps());
        const other = new FakeConnector();
        await setWorkConfigValue({
            configPath,
            path: "global.rules.connectors.other",
            value: { enabled: true, createTypes: ["bug"] },
        });
        const both = { ...deps(), connectors: { fake, other } };
        const preview = await previewSync(both, { all: true });
        expect(preview.preview?.create).toEqual([]);
        expect(preview.preview?.update).toEqual([id]);
        await runSyncOnce(both, { all: true });
        expect(other.pushed).toEqual([]);
        expect(selectPairings(db, { item: id }).map((pairing) => pairing.connector)).toEqual(["fake"]);
    });

    test("a failed parent holds its child for retry", async () => {
        fake.can.parents = true;
        const parent = await spot("s1", "bug", "parent");
        const child = await spot("s1", "bug", "child");
        await write(ctx("s1"), { verb: "edit", ref: child, parent });
        const original = fake.push.bind(fake);
        fake.push = async (intents, context) =>
            intents.some((intent) => intent.item.id === parent)
                ? intents.map(() => ({ ok: false as const, error: "parent unavailable" }))
                : original(intents, context);
        await runSyncOnce(deps());
        expect(fake.pushed).toEqual([]);
        expect(selectPairings(db, { item: child })[0]).toMatchObject({ state: "failed", remoteKey: "" });
        fake.push = original;
        const future = { ...deps(), now: () => new Date(Date.now() + 31_000).toISOString() };
        await runSyncOnce(future);
        expect(fake.pushed.find((intent) => intent.item.id === child)?.parentKey).toBe(`R-${parent}`);
    });

    test("a parent and related-link cycle keeps parent creation before child creation", async () => {
        Object.assign(fake.can, { parents: true, links: true });
        const parent = await spot("s1", "bug", "parent");
        const child = await spot("s1", "bug", "child");
        await write(ctx("s1"), { verb: "edit", ref: child, parent });
        await write(ctx("s1"), { verb: "link", ref: parent, kind: "related", to: child });
        await runSyncOnce(deps());
        expect(fake.pushed.map((intent) => intent.item.id)).toEqual([parent, child]);
        expect(fake.pushed[1].parentKey).toBe(`R-${parent}`);
        expect(selectPairings(db, { item: parent })[0].state).toBe("failed");
        await runSyncOnce({ ...deps(), now: () => new Date(Date.now() + 31_000).toISOString() });
        expect(fake.pushed.at(-1)?.links).toEqual([{ kind: "related", remoteKey: `R-${child}` }]);
    });

    test("outside drift survives a failed push and taking theirs clears local drift", async () => {
        const id = await spot("s1", "bug", "ours");
        await runSyncOnce(deps());
        const key = selectPairings(db, { item: id })[0].remoteKey;
        fake.editedOutside.set(key, "theirs");
        fake.remote.set(key, { remoteKey: key, title: "theirs" });
        await runSyncOnce(deps(), { all: true });
        fake.unavailable = true;
        await runSyncOnce(deps(), { all: true });
        expect(noteStandingDrift(db, { pushed: 0, failed: 0, held: 0, drift: 0, cursor: 0 }).notes?.join()).toContain(
            id
        );
        fake.unavailable = false;
        await resolveDrift(deps(), { item: id, take: "theirs" });
        expect(selectItem(db, id)?.title).toBe("theirs");
        expect(selectPairings(db, { item: id })[0].state).toBe("in-sync");

        fake.remote.set("R-remote", { remoteKey: "R-remote", title: "outside" });
        const made = await pullRemote(deps(), { connector: "fake", remoteKeys: ["R-remote"] });
        const remoteId = made.made[0];
        await write(ctx("s1"), { verb: "edit", ref: remoteId, title: "local edit" });
        await runSyncOnce(deps());
        expect(selectPairings(db, { item: remoteId })[0].state).toBe("drift");
        await resolveDrift(deps(), { item: remoteId, take: "theirs" });
        expect(selectItem(db, remoteId)?.title).toBe("outside");
        expect(selectPairings(db, { item: remoteId })[0].state).toBe("in-sync");
    });

    test("resolution refuses a newer local edit made while the pull is pending", async () => {
        const id = await spot("s1", "bug", "ours");
        await runSyncOnce(deps());
        const original = fake.pull.bind(fake);
        fake.pull = async (ask, context) => {
            await write(ctx("s1"), { verb: "edit", ref: id, title: "newer local edit" });
            return original(ask, context);
        };
        await expect(resolveDrift(deps(), { item: id, take: "theirs", facts: ["title"] })).rejects.toThrow(
            "changed during"
        );
        expect(selectItem(db, id)?.title).toBe("newer local edit");
    });

    test("a re-pair while pulling refuses facts from the earlier task", async () => {
        const id = await spot("s1", "bug", "ours");
        await runSyncOnce(deps());
        const pairing = selectPairings(db, { item: id })[0];
        const original = fake.pull.bind(fake);
        fake.pull = async (ask, context) => {
            applyChange(db, {
                v: 1,
                ts: new Date().toISOString(),
                item: id,
                actor: actor("s1"),
                kind: "paired",
                payload: { pairing: { ...pairing, remoteKey: "replacement" } },
                origin: { via: "connector", id: "fake" },
            });
            return original(ask, context);
        };
        await expect(resolveDrift(deps(), { item: id, take: "theirs", facts: ["title"] })).rejects.toThrow(
            "changed during"
        );
        expect(selectItem(db, id)?.title).toBe("ours");
        expect(selectPairings(db, { item: id })[0].remoteKey).toBe("replacement");
    });

    test("unsupported outside parent resolution is an explicit failure", async () => {
        const id = await spot("s1", "bug", "ours");
        await runSyncOnce(deps());
        const result = await resolveDrift(deps(), { item: id, take: "theirs", facts: ["parent"] });
        expect(result.failed).toBe(1);
        expect(result.problems?.[0].note).toContain("parent");
    });
});

describe("the sync consumer", () => {
    test("a later pass retries only failed pairings after their cooldown", async () => {
        await spot("s1", "bug", "already synced");
        const start = deps();
        await runSyncOnce(start);

        const id = await spot("s1", "bug", "retry this");
        fake.unavailable = true;
        const now = Date.parse(start.now());
        expect((await runSyncOnce({ ...start, now: () => new Date(now).toISOString() })).failed).toBe(1);
        expect(selectPairings(db, { item: id })[0].state).toBe("failed");

        fake.unavailable = false;
        expect((await runSyncOnce({ ...start, now: () => new Date(now + 1).toISOString() })).pushed).toBe(0);
        expect((await runSyncOnce({ ...start, now: () => new Date(now + 31_000).toISOString() })).pushed).toBe(1);
        expect(fake.pushed.map(({ item }) => item.title)).toEqual(["already synced", "retry this", "retry this"]);
    });

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
            {
                context: {
                    project: "App",
                    settings: { target: "App" },
                    machinePrefix: "m-",
                    keepAlive: expect.any(Function),
                },
                titles: ["app bug"],
            },
            {
                context: {
                    project: "Other",
                    settings: { target: "Other" },
                    machinePrefix: "m-",
                    keepAlive: expect.any(Function),
                },
                titles: ["first task", "second task"],
            },
        ]);
        // The lease is held during each push, so a connector that waits can renew it.
        expect(fake.keptAlive).toEqual([true, true]);
        for (const { item, labels } of fake.pushed) {
            expect(labels).toEqual([`${item.project}/${item.id}`]);
        }
    });

    test("a pull in Other can use the same outside key as App without updating App's item", async () => {
        const sync = deps();
        fake.remote.set("R-1", { remoteKey: "R-1", title: "app task" });
        const app = await pullRemote(sync, { connector: "fake", remoteKeys: ["R-1"] });
        const set = await setWorkConfigValue({
            configPath,
            path: "projects.Other.rules.connectors.fake.settings",
            value: { target: "Other" },
        });
        expect(set.ok).toBe(true);

        fake.remote.set("R-1", { remoteKey: "R-1", title: "other task" });
        const other = await pullRemote({ ...sync, project: "Other" }, { connector: "fake", remoteKeys: ["R-1"] });
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

    test("an agent's own epic is made outside; a hold by another session comes back in every later pass", async () => {
        const epic = await write(ctx("maker"), { verb: "add", title: "agent epic", type: "epic" });
        const id = epic.ok ? epic.data.items[0].id : asItemId("none");
        expect((await runSyncOnce(deps())).held).toBe(0);
        expect(selectPairings(db, { item: id })[0].state).toBe("in-sync");

        await write(ctx("other"), { verb: "comment", ref: id, text: "a note" });
        expect((await runSyncOnce(deps())).held).toBe(1);
        const later = await runSyncOnce(deps());
        expect(later.held).toBe(1);
        expect(later.problems?.[0]).toMatchObject({ item: id, state: "held" });
        expect((await previewSync(deps())).preview?.hold).toEqual([id]);
    });

    test("a move under another parent by any session is pushed, not held", async () => {
        const top = await write(ctx("owner-s", "owner"), { verb: "add", title: "top", type: "epic" });
        const sub = await write(ctx("owner-s", "owner"), { verb: "add", title: "sub", type: "epic" });
        const topId = top.ok ? top.data.items[0].id : asItemId("none");
        const subId = sub.ok ? sub.data.items[0].id : asItemId("none");
        await runSyncOnce(deps());

        expect((await write(ctx("other"), { verb: "edit", ref: subId, parent: topId })).ok).toBe(true);
        const report = await runSyncOnce(deps());
        expect(report.held).toBe(0);
        expect(report.pushed).toBe(1);
    });

    test("a title edited outside is not overwritten: the pairing drifts, every pass names it, and resolve settles it", async () => {
        const made = await write(ctx("s1"), { verb: "add", title: "first", type: "bug" });
        const id = made.ok ? made.data.items[0].id : asItemId("none");
        await runSyncOnce(deps());
        fake.editedOutside.set(`R-${id}`, "renamed outside");
        fake.remote.set(`R-${id}`, { remoteKey: `R-${id}`, title: "renamed outside", state: "open" });

        await write(ctx("s1"), { verb: "edit", ref: id, title: "renamed here" });
        const pass = await runSyncOnce(deps());
        expect(pass.drift).toBe(1);
        expect(pass.problems?.[0]).toMatchObject({ item: id, state: "drift" });
        expect(pass.problems?.[0].note).toContain('title (outside "renamed outside", here "renamed here")');
        expect(selectPairings(db, { item: id })[0]).toMatchObject({
            state: "drift",
            note: "changed outside, owned here: title",
        });
        expect(noteStandingDrift(db, await runSyncOnce(deps())).notes?.at(-1)).toContain(
            `1 item(s) differ outside and here (${id})`
        );

        const theirs = await resolveDrift(deps(), { item: id, take: "theirs" });
        expect(theirs.drift).toBe(0);
        expect(selectItem(db, id)?.title).toBe("renamed outside");
        expect(selectPairings(db, { item: id })[0].state).toBe("in-sync");

        fake.editedOutside.set(`R-${id}`, "outside again");
        await write(ctx("s1"), { verb: "edit", ref: id, title: "mine" });
        await runSyncOnce(deps());
        expect(selectPairings(db, { item: id })[0].state).toBe("drift");
        const ours = await resolveDrift(deps(), { item: id, take: "ours" });
        expect(ours.pushed).toBe(1);
        expect(fake.pushed.at(-1)?.force).toEqual(["title"]);
        expect(selectPairings(db, { item: id })[0].state).toBe("in-sync");
    });

    test("a change by a role that may not push is held, and a release pushes it", async () => {
        const epic = await write(ctx("owner-s", "owner"), { verb: "add", title: "big", type: "epic" });
        const id = epic.ok ? epic.data.items[0].id : asItemId("none");
        await runSyncOnce(deps());
        expect(selectPairings(db, { item: id })[0].state).toBe("in-sync");

        await write(ctx("other"), { verb: "comment", ref: id, text: "a note" });
        await write(ctx("owner-s", "owner"), { verb: "comment", ref: id, text: "another note" });
        const report = await runSyncOnce(deps());
        expect(report.held).toBe(1);
        expect(selectPairings(db, { item: id })[0].state).toBe("held");

        const released = await releaseHeld(deps(), id);
        expect(released.pushed).toBe(1);
        expect(selectPairings(db, { item: id })[0].state).toBe("in-sync");
    });

    test("a pull makes an unknown outside item a local one born outside; a change of a local fact is drift, never applied", async () => {
        fake.remote.set("R-9", { remoteKey: "R-9", title: "from outside", state: "open" });
        const made = await pullRemote(deps(), { connector: "fake", remoteKeys: ["R-9"] });
        const local = made.made[0];
        expect(selectItem(db, local)?.title).toBe("from outside");
        expect(selectPairings(db, { item: local })[0]).toMatchObject({ born: "remote", remoteKey: "R-9" });

        fake.remote.set("R-9", { remoteKey: "R-9", title: "renamed outside", state: "done" });
        const second = await pullRemote(deps(), { connector: "fake", remoteKeys: ["R-9"] });
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
        const made = await pullRemote(deps(), { connector: "fake", remoteKeys: ["R-5"] });
        const id = made.made[0];
        await runSyncOnce(deps());
        await write(ctx("s1"), { verb: "edit", ref: id, title: "renamed here" });
        const report = await runSyncOnce(deps());
        expect(report.drift).toBe(1);
        expect(selectPairings(db, { item: id })[0]).toMatchObject({ state: "drift" });
        expect(selectPairings(db, { item: id })[0].note).toContain("title");
        expect(fake.remote.get("R-5")?.title).toBe("made outside");

        const local = await spot("s1", "bug");
        await runSyncOnce(deps());
        const key = selectPairings(db, { item: local })[0].remoteKey;
        await write(ctx("s1"), { verb: "edit", ref: local, title: "locally owned edit" });
        await runSyncOnce(deps());
        expect(fake.remote.get(key)?.title).toBe("locally owned edit");
    });

    test("a later successful push keeps the drift of a fact the outside owns, also through a failed push", async () => {
        fake.remote.set("R-6", { remoteKey: "R-6", title: "made outside", state: "open" });
        const id = (await pullRemote(deps(), { connector: "fake", remoteKeys: ["R-6"] })).made[0];
        await runSyncOnce(deps());
        await write(ctx("s1"), { verb: "edit", ref: id, title: "renamed here" });
        await runSyncOnce(deps());
        expect(selectPairings(db, { item: id })[0]).toMatchObject({ state: "drift" });

        fake.unavailable = true;
        await write(ctx("s1"), { verb: "comment", ref: id, text: "a later change" });
        await runSyncOnce(deps());
        const failed = selectPairings(db, { item: id })[0];
        expect(failed.state).toBe("failed");
        expect(failed.note).toBe("temporarily unavailable\nchanged here, owned outside: title");

        fake.unavailable = false;
        await write(ctx("s1"), { verb: "comment", ref: id, text: "one more change" });
        const report = await runSyncOnce(deps());
        expect(report.pushed).toBe(1);
        const pairing = selectPairings(db, { item: id })[0];
        expect(pairing.state).toBe("drift");
        expect(pairing.note).toStartWith("changed here, owned outside: title");
        expect(fake.remote.get("R-6")?.title).toBe("made outside");
    });

    test("a pull that restores the remote title clears its local drift, so a later push reads in-sync", async () => {
        fake.remote.set("R-7", { remoteKey: "R-7", title: "made outside", state: "open" });
        const id = (await pullRemote(deps(), { connector: "fake", remoteKeys: ["R-7"] })).made[0];
        await runSyncOnce(deps());
        await write(ctx("s1"), { verb: "edit", ref: id, title: "renamed here" });
        await runSyncOnce(deps());
        expect(selectPairings(db, { item: id })[0]).toMatchObject({ state: "drift" });

        await pullRemote(deps(), { connector: "fake", remoteKeys: ["R-7"] });
        expect(selectPairings(db, { item: id })[0]).toMatchObject({ state: "in-sync" });

        await write(ctx("s1"), { verb: "comment", ref: id, text: "a later change" });
        expect((await runSyncOnce(deps())).pushed).toBe(1);
        const pairing = selectPairings(db, { item: id })[0];
        expect(pairing.state).toBe("in-sync");
        expect(pairing.note).toBeUndefined();
    });

    test("a connector error that starts like a drift line is never kept as drift after a successful push", async () => {
        fake.remote.set("R-8", { remoteKey: "R-8", title: "made outside", state: "open" });
        const id = (await pullRemote(deps(), { connector: "fake", remoteKeys: ["R-8"] })).made[0];
        await runSyncOnce(deps());

        fake.unavailable = true;
        fake.failure = "changed here, owned outside: title\nand a second line";
        await write(ctx("s1"), { verb: "comment", ref: id, text: "a change" });
        await runSyncOnce(deps());
        const failed = selectPairings(db, { item: id })[0];
        expect(failed.state).toBe("failed");
        expect(failed.note).toBe("changed here, owned outside: title and a second line");

        fake.unavailable = false;
        fake.failure = "temporarily unavailable";
        await write(ctx("s1"), { verb: "comment", ref: id, text: "one more change" });
        expect((await runSyncOnce(deps())).pushed).toBe(1);
        expect(selectPairings(db, { item: id })[0]).toMatchObject({ state: "in-sync" });
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
    test("pull, sync and release previews do not change the store or call connectors", async () => {
        const id = await spot("s1", "bug");
        fake.remote.set("R-1", { remoteKey: "R-1", title: "outside" });
        const preview = { ...session(true), call: { dryRun: true } };
        const changes = db.query("SELECT * FROM changes ORDER BY seq").all();
        const cursors = db.query("SELECT * FROM cursors").all();

        expect(await callWork("pull", { connector: "fake", keys: ["R-1"] }, preview)).toMatchObject({
            ok: true,
            dryRun: true,
        });
        expect(await callWork("sync", {}, preview)).toMatchObject({
            ok: true,
            dryRun: true,
            data: { preview: { create: [id], update: [], hold: [] } },
        });
        expect(await callWork("sync", { release: id }, preview)).toMatchObject({ ok: true, dryRun: true });
        expect(fake.pulls).toEqual([]);
        expect(fake.pushed).toEqual([]);
        expect(db.query("SELECT * FROM changes ORDER BY seq").all()).toEqual(changes);
        expect(db.query("SELECT * FROM cursors").all()).toEqual(cursors);
        expect(selectPairings(db, { item: id })).toEqual([]);
    });

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

    test("bulk resolution attempts every pairing and reports every thrown connector error", async () => {
        const id = await spot("s1", "bug", "ours");
        await runSyncOnce(deps());
        const pairing = selectPairings(db, { item: id })[0];
        for (const connector of ["fake", "missing"]) {
            applyChange(db, {
                v: 1,
                ts: new Date().toISOString(),
                item: id,
                actor: actor("s1"),
                kind: "paired",
                payload: {
                    pairing: { ...pairing, connector, state: "drift", note: "changed outside, owned here: title" },
                },
                origin: { via: "connector", id: connector },
            });
        }
        fake.pull = async () => {
            throw new Error("read failed");
        };
        const reply = await callWork("sync", { resolve: "all", take: "theirs" }, session(true));
        expect(reply.ok && reply.data).toMatchObject({ failed: 2 });
        expect(reply.ok && reply.data).toMatchObject({
            problems: expect.arrayContaining([
                expect.objectContaining({ connector: "fake", state: "failed" }),
                expect.objectContaining({ connector: "missing", state: "failed" }),
            ]),
        });
    });

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

describe("what a push makes outside", () => {
    async function useConfig(value: Record<string, unknown>): Promise<void> {
        const set = await setWorkConfigValue({ configPath, path: "global.rules.connectors.fake", value });
        expect(set.ok).toBe(true);
    }

    async function add(
        type: "epic" | "task" | "bug",
        title: string,
        parent?: ItemId,
        tags?: string[]
    ): Promise<ItemId> {
        const made = await write(ctx("owner-s", "owner"), {
            verb: "add",
            title,
            type,
            ...(parent !== undefined ? { parent } : {}),
            ...(tags !== undefined ? { tags } : {}),
        });
        return made.ok ? made.data.items[0].id : asItemId("none");
    }

    function memberOf(handoff: string, item: ItemId, slot: string): void {
        applyChange(db, {
            v: 1,
            ts: new Date().toISOString(),
            item: asItemId(handoff),
            actor: actor("s1"),
            kind: "linked",
            payload: { kind: "member", to: item, slot },
            origin: { via: "local" },
        });
    }

    test("a child made in the same pass carries its parent's outside key, and its links carry theirs", async () => {
        Object.assign(fake.can, { parents: true, links: true });
        await useConfig({ enabled: true, createTypes: ["epic", "task", "bug"] });
        const epic = await add("epic", "the epic");
        const child = await add("task", "a child", epic);
        const other = await add("bug", "a related bug");
        await write(ctx("owner-s", "owner"), { verb: "link", ref: other, kind: "related", to: epic });

        const report = await runSyncOnce(deps());
        expect(report).toMatchObject({ pushed: 3, failed: 0 });
        const intents = new Map(fake.pushed.map((intent) => [intent.item.id, intent]));
        expect(intents.get(epic)?.parentKey).toBeNull();
        expect(intents.get(child)?.parentKey).toBe(`R-${epic}`);
        expect(intents.get(other)?.links).toEqual([{ kind: "related", remoteKey: `R-${epic}` }]);
        expect(fake.batches.map((batch) => batch.titles)).toEqual([["the epic"], ["a child", "a related bug"]]);

        fake.pushed = [];
        const again = await runSyncOnce(deps(), { all: true });
        expect(again.pushed).toBe(3);
        expect(new Map(fake.pushed.map((intent) => [intent.item.id, intent.parentKey])).get(child)).toBe(`R-${epic}`);
    });

    test("a connector without parents gets no parent key", async () => {
        await useConfig({ enabled: true, createTypes: ["epic", "task"] });
        const epic = await add("epic", "the epic");
        await add("task", "a child", epic);
        await runSyncOnce(deps());
        expect(fake.pushed.map((intent) => intent.parentKey)).toEqual([undefined, undefined]);
    });

    test("a handoff's tasks are not made outside unless the scope says so; the report says why", async () => {
        await useConfig({ enabled: true, createTypes: ["task", "bug"] });
        const task = await add("task", "a session's step");
        memberOf("h_fixture1", task, "t1");
        const bug = await add("bug", "a team bug");

        const report = await runSyncOnce(deps());
        expect(fake.pushed.map((intent) => intent.item.id)).toEqual([bug]);
        expect(report.notes).toEqual([
            "fake in App: 1 handoff task(s) not made outside, because scope.handoffTasks is off",
        ]);
        expect(selectPairings(db, { item: task })).toEqual([]);

        await useConfig({ enabled: true, createTypes: ["task", "bug"], scope: { handoffTasks: true } });
        // A write on a handoff task goes through its handoff; the journal entry alone is what the sync reads.
        applyChange(db, {
            v: 1,
            ts: new Date().toISOString(),
            item: task,
            actor: actor("s1"),
            kind: "edited",
            payload: { set: { title: "a step, renamed" } },
            origin: { via: "local" },
        });
        await runSyncOnce(deps());
        expect(selectPairings(db, { item: task })[0].state).toBe("in-sync");
    });

    test("scope.under and scope.tags take an item under a listed one or with a listed tag, and nothing else", async () => {
        const epic = await add("epic", "the epic");
        await useConfig({
            enabled: true,
            createTypes: ["epic", "task", "bug"],
            scope: { under: [epic], tags: ["team"] },
        });
        const child = await add("task", "under it", epic);
        const loose = await add("bug", "elsewhere");
        const tagged = await add("bug", "tagged", undefined, ["team"]);

        const report = await runSyncOnce(deps());
        expect(new Set(fake.pushed.map((intent) => intent.item.id))).toEqual(new Set([epic, child, tagged]));
        expect(selectPairings(db, { item: loose })).toEqual([]);
        expect(report.notes).toEqual([
            "fake in App: 1 new item(s) not made outside, outside scope.under and scope.tags",
        ]);
    });

    test("an empty createTypes says so; a held item and a failed item come back with their reasons", async () => {
        await useConfig({ enabled: true, createTypes: [] });
        await add("bug", "nothing makes me");
        const empty = await runSyncOnce(deps());
        expect(empty.notes).toEqual(["fake in App: 1 new item(s) not made outside, because createTypes is empty"]);

        await useConfig({ enabled: true, createTypes: ["bug", "epic"] });
        const epic = await write(ctx("agent-s"), { verb: "spot", title: "an epic", type: "epic", fields: {} });
        const epicId = epic.ok ? epic.data.items[0].id : asItemId("none");
        await write(ctx("other-s"), { verb: "comment", ref: epicId, text: "not the poster" });
        fake.unavailable = true;
        const bug = await spot("s1", "bug", "fails");
        const report = await runSyncOnce(deps());
        expect(report.problems).toEqual([
            {
                item: epicId,
                connector: "fake",
                state: "held",
                note: `a change needs a lead or the owner to release it; release it with \`sync --release ${epicId}\``,
            },
            { item: bug, connector: "fake", state: "failed", note: "temporarily unavailable" },
        ]);
    });

    test("a preview lists what a pass would make, update and hold, and changes nothing", async () => {
        const first = await spot("s1", "bug", "already out");
        await runSyncOnce(deps());
        await write(ctx("s1"), { verb: "comment", ref: first, text: "changed" });
        const fresh = await spot("s1", "bug", "new");
        const cursors = db.query("SELECT * FROM cursors").all();
        fake.pushed = [];

        const preview = await previewSync(deps());
        expect(preview.preview).toEqual({ create: [fresh], update: [first], hold: [] });
        expect(fake.pushed).toEqual([]);
        expect(db.query("SELECT * FROM cursors").all()).toEqual(cursors);
        expect(selectPairings(db, { item: fresh })).toEqual([]);
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
