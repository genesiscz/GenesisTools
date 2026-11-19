/**
 * The sync feed consumer: it reads the journal after its cursor, under a lease (one runner), and pushes each changed
 * item to the connectors its project enables. It runs after a commit, never inside one, so a write never waits for
 * the network. A change by a role that may not push is applied here and HELD there; a remote change of a fact the
 * local side owns is recorded as drift and never applied.
 */
import type { Database } from "bun:sqlite";
import { SafeJSON } from "@genesiscz/utils/json";
import type { Change } from "../model/change";
import type { Actor, Item, ItemId } from "../model/item";
import { asItemId } from "../model/item";
import type { EditedPayload, ItemPatch } from "../model/payloads";
import { type ItemType, levelOf, type Role } from "../model/vocab";
import { type LoadProjectRules, loadRulesForItems } from "../rules/load";
import { allows, type RuleLayerInput } from "../rules/resolve";
import { rolesOf } from "../rules/roles";
import { applyChange } from "../store/apply";
import { selectChangesAfter, selectItem, selectPairings } from "../store/rows";
import { sqlView } from "../store/view";
import { connectorConfigOf } from "./config";
import {
    type Connector,
    type ConnectorContext,
    DEFAULT_LABEL_TEMPLATE,
    DRIFT_NOTE_PREFIX,
    originFor,
    type Pairing,
    type PushIntent,
    pairingLabelFor,
    type RemoteItem,
    SYNCED_FACTS,
    type SyncedFact,
} from "./types";

/** What one project's config says about one connector. */
export interface ConnectorConfig {
    enabled: boolean;
    settings: unknown;
    labelTemplate: string;
    /** The types whose new items are made outside by the push. */
    createTypes: readonly ItemType[];
    /** Who may push a change of an item of this type; `undefined` takes the default of its level. */
    push(type: ItemType): readonly Role[] | "anyone" | undefined;
}

export interface SyncDeps {
    db: Database;
    connectors: Readonly<Record<string, Connector<unknown>>>;
    loadRules: LoadProjectRules;
    machinePrefix: string;
    now: () => string;
    /** The lease holder's name; one runner at a time. */
    owner: string;
}

const CURSOR = "sync";
const LEASE_MS = 120_000;
const BATCH = 500;

/** Who may push by default (design C, the last row of the write rules). */
function defaultPush(type: ItemType): readonly Role[] | "anyone" {
    if (type === "epic" || levelOf(type) === "note") {
        return ["lead", "owner"];
    }

    return type === "handoff" ? ["poster", "lead", "owner"] : "anyone";
}

const CONNECTOR_ACTOR = (id: string): Actor => ({
    kind: "connector",
    harness: id,
    sessionId: null,
    sessionTitle: null,
    model: null,
    host: null,
    subagentId: null,
    project: null,
    repoRoot: null,
    branch: null,
    commitSha: null,
});

function writePairing(db: Database, deps: Pick<SyncDeps, "now">, pairing: Pairing): void {
    applyChange(db, {
        v: 1,
        ts: deps.now(),
        item: pairing.item,
        actor: CONNECTOR_ACTOR(pairing.connector),
        kind: "paired",
        payload: { pairing: { ...pairing, updatedTs: deps.now() } },
        origin: { via: "connector", id: pairing.connector },
    });
}

function inTransaction(db: Database, fn: () => void): void {
    db.run("BEGIN IMMEDIATE");

    try {
        fn();
        db.run("COMMIT");
    } catch (error) {
        db.run("ROLLBACK");
        throw error;
    }
}

/** Takes the lease of the sync cursor; false when another runner holds it. */
export function takeLease(db: Database, owner: string, now: string): boolean {
    const until = new Date(Date.parse(now) + LEASE_MS).toISOString();
    db.run("INSERT OR IGNORE INTO cursors (consumer, seq, lease_owner, lease_until) VALUES (?, 0, NULL, NULL)", [
        CURSOR,
    ]);
    const taken = db.run(
        "UPDATE cursors SET lease_owner = ?, lease_until = ? WHERE consumer = ? AND (lease_owner IS NULL OR lease_owner = ? OR lease_until < ?)",
        [owner, until, CURSOR, owner, now]
    );
    return taken.changes > 0;
}

export function dropLease(db: Database, owner: string): void {
    db.run("UPDATE cursors SET lease_owner = NULL, lease_until = NULL WHERE consumer = ? AND lease_owner = ?", [
        CURSOR,
        owner,
    ]);
}

function containersOf(db: Database, item: ItemId): string[] {
    const view = sqlView(db);
    return [
        ...view.memberships(item).map((m) => m.handoff),
        ...(view.parentOf(item) !== null ? [view.parentOf(item) as string] : []),
    ];
}

export interface SyncReport {
    pushed: number;
    held: number;
    failed: number;
    /** Pairings marked drift in this pass: a local edit of a fact the outside owns, which is never pushed. */
    drift: number;
    skipped?: "lease";
    cursor: number;
}

interface ChangedItem {
    item: Item;
    actor: Actor | null;
    release: boolean;
}

async function pushItems(deps: SyncDeps, items: ChangedItem[], report: SyncReport): Promise<void> {
    const projects = await loadRulesForItems(items, deps.loadRules);

    for (const [project, { entries, loaded }] of projects) {
        await pushProject({ deps, items: entries, project, layers: loaded.rules.layers, report });
    }
}

async function pushProject({
    deps,
    items,
    project,
    layers,
    report,
}: {
    deps: SyncDeps;
    items: ChangedItem[];
    project: string;
    layers: readonly RuleLayerInput[];
    report: SyncReport;
}): Promise<void> {
    const { db } = deps;
    const view = sqlView(db);

    for (const [id, connector] of Object.entries(deps.connectors)) {
        const config = connectorConfigOf(layers, id).config;

        if (!config?.enabled) {
            continue;
        }

        const intents: PushIntent[] = [];

        for (const { item, actor, release } of items) {
            const pairing = selectPairings(db, { item: item.id, connector: id })[0] ?? null;

            if (pairing === null && !(connector.can.create && config.createTypes.includes(item.type))) {
                continue;
            }

            const rule = config.push(item.type) ?? defaultPush(item.type);
            const roles =
                actor === null
                    ? []
                    : rolesOf(view, item, {
                          lineage: actor.sessionId !== null ? [actor.sessionId] : [],
                          ownerKind: actor.kind === "owner",
                      });

            if (!release && actor !== null && actor.kind !== "connector" && !allows(rule, roles)) {
                if (pairing !== null) {
                    inTransaction(db, () =>
                        writePairing(db, deps, {
                            ...pairing,
                            state: "held",
                            note: `a change by ${roles.join(", ") || "a session with no role"}; a lead or the owner releases it`,
                        })
                    );
                }

                report.held++;
                continue;
            }

            const machine = deps.machinePrefix;
            const labels = [item.id, ...containersOf(db, item.id)].map((target) =>
                pairingLabelFor(config.labelTemplate || DEFAULT_LABEL_TEMPLATE, {
                    machine,
                    project: item.project,
                    id: target,
                })
            );
            intents.push({ item, pairing, labels });
        }

        if (intents.length === 0) {
            continue;
        }

        const ctx: ConnectorContext = {
            settings: config.settings,
            project,
            machinePrefix: deps.machinePrefix,
        };
        const results = await connector.push(intents, ctx);

        inTransaction(db, () => {
            intents.forEach((intent, index) => {
                const result = results[index] ?? { ok: false as const, error: "the connector answered no result" };
                const base: Pairing = intent.pairing ?? {
                    item: intent.item.id,
                    connector: id,
                    remoteKey: "",
                    born: "local",
                    origin: originFor("local"),
                    state: "pending",
                    updatedTs: deps.now(),
                };

                if (result.ok) {
                    writePairing(db, deps, { ...base, remoteKey: result.remoteKey, state: "in-sync", note: undefined });
                    report.pushed++;
                } else {
                    writePairing(db, deps, { ...base, state: "failed", note: result.error });
                    report.failed++;
                }
            });
        });
    }
}

/**
 * The other direction of drift: a local edit of a fact the outside owns (the title of a task born outside). The push
 * never sends it; the pairing says so, after the push, so a successful push of the local facts does not hide it.
 */
function markLocalDrift(deps: SyncDeps, changes: readonly Change[], report: SyncReport): void {
    for (const change of changes) {
        if (change.kind !== "edited" || change.origin.via === "connector" || change.origin.via === "legacy") {
            continue;
        }

        const set = (change.payload as EditedPayload).set;
        const keys = Object.keys(set);

        for (const pairing of selectPairings(deps.db, { item: change.item })) {
            const owned = SYNCED_FACTS.filter((fact) => pairing.origin[fact] === "remote" && keys.includes(fact));

            if (owned.length > 0) {
                inTransaction(deps.db, () =>
                    writePairing(deps.db, deps, {
                        ...pairing,
                        state: "drift",
                        note: `${DRIFT_NOTE_PREFIX.local} ${owned.join(", ")}`,
                    })
                );
                report.drift++;
            }
        }
    }
}

/** One pass: every change after the cursor, pushed under the lease. Safe to run again: it starts at its cursor. */
export async function runSyncOnce(deps: SyncDeps): Promise<SyncReport> {
    const { db } = deps;
    const now = deps.now();

    if (!takeLease(db, deps.owner, now)) {
        return { pushed: 0, held: 0, failed: 0, drift: 0, skipped: "lease", cursor: -1 };
    }

    const report: SyncReport = { pushed: 0, held: 0, failed: 0, drift: 0, cursor: 0 };

    try {
        const cursor = (db.query("SELECT seq FROM cursors WHERE consumer = ?").get(CURSOR) as { seq: number }).seq;
        const changes = selectChangesAfter(db, cursor, BATCH);
        const touched = new Map<string, Actor>();

        for (const change of changes) {
            // A change a connector made (a pull, a pairing) is not pushed back.
            if (change.origin.via !== "connector") {
                touched.set(change.item, change.actor);
            }
        }

        const items = [...touched.entries()]
            .map(([id, actor]) => ({ item: selectItem(db, id), actor, release: false }))
            .filter((entry): entry is { item: Item; actor: Actor; release: boolean } => entry.item !== null);
        await pushItems(deps, items, report);
        markLocalDrift(deps, changes, report);
        const last = changes.length > 0 ? changes[changes.length - 1].seq : cursor;
        db.run("UPDATE cursors SET seq = ? WHERE consumer = ?", [last, CURSOR]);
        report.cursor = last;
        return report;
    } finally {
        dropLease(db, deps.owner);
    }
}

/** `sync --release <ref>`: push a held change now, whatever role made it. */
export async function releaseHeld(deps: SyncDeps, item: ItemId): Promise<SyncReport> {
    const report: SyncReport = { pushed: 0, held: 0, failed: 0, drift: 0, cursor: -1 };
    const row = selectItem(deps.db, item);

    if (row !== null) {
        await pushItems(deps, [{ item: row, actor: null, release: true }], report);
    }

    return report;
}

function factOf(item: Item, fact: SyncedFact): unknown {
    switch (fact) {
        case "title":
            return item.title;
        case "body":
            return item.body;
        case "type":
            return item.type;
        case "state":
            return item.state;
        case "severity":
            return item.severity;
        case "tags":
            return item.tags;
        case "parent":
            return undefined;
    }
}

function remoteFact(remote: RemoteItem, fact: SyncedFact): unknown {
    return fact === "parent" ? undefined : remote[fact];
}

export interface PullReport {
    made: ItemId[];
    updated: ItemId[];
    drift: ItemId[];
}

/**
 * Reads outside items. An unknown one becomes a local item born outside ("move = pair, never move"); a known one
 * brings the facts the outside owns, and a difference in a fact the local side owns is drift.
 */
export async function pullRemote(
    deps: SyncDeps & { newId: () => ItemId; project: string },
    connectorId: string,
    remoteKeys: readonly string[]
): Promise<PullReport> {
    const connector = deps.connectors[connectorId];
    const report: PullReport = { made: [], updated: [], drift: [] };

    if (connector === undefined || !connector.can.pull) {
        return report;
    }

    const loaded = await deps.loadRules({ project: deps.project });
    const config = connectorConfigOf(loaded.rules.layers, connectorId).config;
    const remotes = await connector.pull(
        { remoteKeys },
        { settings: config?.settings, project: deps.project, machinePrefix: deps.machinePrefix }
    );
    const { db } = deps;
    const actor = CONNECTOR_ACTOR(connectorId);
    const origin = { via: "connector" as const, id: connectorId };

    inTransaction(db, () => {
        for (const remote of remotes) {
            const pairing = selectPairings(db, {
                project: deps.project,
                connector: connectorId,
                remoteKey: remote.remoteKey,
            })[0];

            if (pairing === undefined) {
                const id = deps.newId();
                applyChange(db, {
                    v: 1,
                    ts: deps.now(),
                    item: id,
                    actor,
                    origin,
                    kind: "created",
                    payload: {
                        type: remote.type ?? "task",
                        state: remote.state ?? "open",
                        project: deps.project,
                        title: remote.title ?? remote.remoteKey,
                        ...(remote.body !== undefined ? { body: remote.body } : {}),
                        ...(remote.severity !== undefined ? { severity: remote.severity } : {}),
                        tags: remote.tags ?? [],
                        fields: {},
                    },
                });
                writePairing(db, deps, {
                    item: id,
                    connector: connectorId,
                    remoteKey: remote.remoteKey,
                    born: "remote",
                    origin: originFor("remote"),
                    state: "in-sync",
                    updatedTs: deps.now(),
                });
                report.made.push(id);
                continue;
            }

            const item = selectItem(db, pairing.item);

            if (item === null) {
                continue;
            }

            const set: ItemPatch = {};
            const drifted: SyncedFact[] = [];

            for (const fact of SYNCED_FACTS) {
                const theirs = remoteFact(remote, fact);

                if (theirs === undefined || SafeJSON.stringify(theirs) === SafeJSON.stringify(factOf(item, fact))) {
                    continue;
                }

                if (pairing.origin[fact] === "remote") {
                    if (fact === "title" || fact === "body") {
                        set[fact] = String(theirs);
                    } else if (fact === "tags" && Array.isArray(theirs)) {
                        set.tags = theirs.map(String);
                    } else if (fact === "type" && remote.type !== undefined) {
                        set.type = remote.type;
                    }
                } else {
                    drifted.push(fact);
                }
            }

            if (Object.keys(set).length > 0) {
                applyChange(db, {
                    v: 1,
                    ts: deps.now(),
                    item: item.id,
                    actor,
                    origin,
                    kind: "edited",
                    payload: { set },
                });
                report.updated.push(item.id);
            }

            if (drifted.length > 0) {
                writePairing(db, deps, {
                    ...pairing,
                    state: "drift",
                    note: `${DRIFT_NOTE_PREFIX.remote} ${drifted.join(", ")}`,
                });
                report.drift.push(item.id);
            }
        }
    });

    return report;
}

/** `pair <ref> <connector> <key>`: one more pairing row on a local item; the next push brings the label outside. */
export function pairItem(
    deps: Pick<SyncDeps, "db" | "now">,
    item: ItemId,
    connector: string,
    remoteKey: string,
    state: Pairing["state"] = "pending"
): Pairing {
    const pairing: Pairing = {
        item,
        connector,
        remoteKey,
        born: "local",
        origin: originFor("local"),
        state,
        updatedTs: deps.now(),
    };
    inTransaction(deps.db, () => writePairing(deps.db, deps, pairing));
    return pairing;
}

/** `unpair <ref> <connector>`: the pairing row goes; nothing changes outside. */
export function unpairItem(deps: Pick<SyncDeps, "db" | "now">, item: ItemId, connector: string): boolean {
    const had = selectPairings(deps.db, { item, connector }).length > 0;

    if (had) {
        inTransaction(deps.db, () =>
            applyChange(deps.db, {
                v: 1,
                ts: deps.now(),
                item,
                actor: CONNECTOR_ACTOR(connector),
                kind: "unpaired",
                payload: { connector },
                origin: { via: "connector", id: connector },
            })
        );
    }

    return had;
}

export { asItemId };
