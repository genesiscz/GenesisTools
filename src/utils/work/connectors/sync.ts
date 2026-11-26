/**
 * The sync feed consumer: it reads the journal after its cursor, under a lease (one runner), and pushes each changed
 * item to the connectors its project enables. It runs after a commit, never inside one, so a write never waits for
 * the network. A change by a role that may not push is applied here and HELD there; a remote change of a fact the
 * local side owns is recorded as drift and never applied.
 */
import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import type { Change } from "../model/change";
import type { Actor, Item, ItemId, Reference } from "../model/item";
import { asItemId } from "../model/item";
import type { EditedPayload, ItemPatch } from "../model/payloads";
import type { ItemType, Role } from "../model/vocab";
import { type LoadProjectRules, loadRulesForItems } from "../rules/load";
import { allows, defaultWrite, type RuleLayerInput } from "../rules/resolve";
import { rolesOf } from "../rules/roles";
import { applyChange } from "../store/apply";
import { journalHead, selectChangesAfter, selectItem, selectPairings, selectRefsFrom } from "../store/rows";
import { sqlView } from "../store/view";
import { connectorConfigOf } from "./config";
import { type ConnectorScope, outOfScope, outsideRefs, referencedItems } from "./scope";
import {
    type Connector,
    type ConnectorContext,
    DEFAULT_LABEL_TEMPLATE,
    DRIFT_NOTE_PREFIX,
    type FactChangedOutside,
    originFor,
    type Pairing,
    type PushIntent,
    type PushResult,
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
    /** Which new items of those types are made outside (handoff tasks, a subtree, tags). */
    scope: ConnectorScope;
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
const RETRY_AFTER_MS = 30_000;

/** Who may push by default: the edit row of the write rules, so the session that made an epic or a note pushes it. */
function defaultPush(type: ItemType): readonly Role[] | "anyone" {
    return defaultWrite(type, "edit");
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
        "UPDATE cursors SET lease_owner = ?, lease_until = ? WHERE consumer = ? AND (lease_owner IS NULL OR lease_until <= ?)",
        [owner, until, CURSOR, now]
    );
    return taken.changes > 0;
}

export function dropLease(db: Database, owner: string): void {
    db.run("UPDATE cursors SET lease_owner = NULL, lease_until = NULL WHERE consumer = ? AND lease_owner = ?", [
        CURSOR,
        owner,
    ]);
}

function renewLease(db: Database, token: string, now: string): boolean {
    const until = new Date(Date.parse(now) + LEASE_MS).toISOString();
    return (
        db.run("UPDATE cursors SET lease_until = ? WHERE consumer = ? AND lease_owner = ? AND lease_until > ?", [
            until,
            CURSOR,
            token,
            now,
        ]).changes > 0
    );
}

function pairingGeneration(db: Database, item: ItemId, connector: string): number | null {
    return (
        db
            .query<{ seq: number | null }, [ItemId, string]>(
                "SELECT MAX(seq) AS seq FROM changes WHERE item = ? AND kind IN ('paired', 'unpaired') AND json_extract(origin, '$.id') = ?"
            )
            .get(item, connector)?.seq ?? null
    );
}

function containersOf(db: Database, item: ItemId): string[] {
    const view = sqlView(db);
    return [
        ...view.memberships(item).map((m) => m.handoff),
        ...(view.parentOf(item) !== null ? [view.parentOf(item) as string] : []),
    ];
}

/** One held, failed or drifted item of a pass, with the reason. */
export interface SyncProblem {
    item: ItemId;
    connector: string;
    state: "held" | "failed" | "drift";
    note: string;
}

export interface SyncReport {
    pushed: number;
    held: number;
    failed: number;
    /** Pairings marked drift in this pass: a local edit of a fact the outside owns, which is never pushed. */
    drift: number;
    skipped?: "lease";
    cursor: number;
    /** Each held or failed item of this pass, with its reason. */
    problems?: SyncProblem[];
    /** What the pass did not make outside, and why: an empty createTypes, the connector's scope. */
    notes?: string[];
    /** Only in a preview: what a real pass would do now. Nothing was sent and nothing was written. */
    preview?: { create: ItemId[]; update: ItemId[]; hold: ItemId[] };
}

type PushMode =
    | {
          kind: "sync";
          cursor: number;
          lease: string;
          touched: ReadonlySet<ItemId>;
          all?: boolean;
          retryBefore: string;
          /** Plan only: no lease, no write, no connector call. */
          preview: boolean;
      }
    | { kind: "release" }
    | { kind: "pair"; connector: string }
    /** `sync --resolve`: push one paired item to its connector, writing `force` whatever the outside holds. */
    | {
          kind: "resolve";
          connector: string;
          force: readonly SyncedFact[];
          generation: number | null;
          remoteKey: string;
      };

const HELD_NOTE = "a change needs a lead or the owner to release it";

/**
 * The actors whose changes a push carries. A move under another parent is a reference, which anyone may write by
 * default, so it holds nothing unless the project set its own push rule (`withPlacements`).
 */
function pushActors(db: Database, id: ItemId, after: number, withPlacements: boolean): Actor[] {
    const placements = withPlacements
        ? ""
        : " AND NOT (kind IN ('linked', 'unlinked') AND json_extract(payload, '$.kind') = 'parent')";
    return db
        .query<{ actor: string }, [ItemId, number]>(
            `SELECT DISTINCT actor FROM changes WHERE item = ? AND seq > ? AND json_extract(origin, '$.via') <> 'connector'${placements}`
        )
        .all(id, after)
        .map(({ actor }) => SafeJSON.parse(actor) as Actor);
}

function newPairing(item: ItemId, connector: string, now: string): Pairing {
    return {
        item,
        connector,
        remoteKey: "",
        born: "local",
        origin: originFor("local"),
        state: "pending",
        updatedTs: now,
    };
}

function addProblem(report: SyncReport, problem: SyncProblem): void {
    report.problems ??= [];
    report.problems.push(problem);
}

function addNote(report: SyncReport, note: string): void {
    report.notes ??= [];
    report.notes.push(note);
}

async function pushItems(input: { deps: SyncDeps; items: Item[]; mode: PushMode; report: SyncReport }): Promise<void> {
    const { deps, items, mode, report } = input;
    const projects = await loadRulesForItems(
        items.map((item) => ({ item })),
        deps.loadRules
    );

    for (const [project, { entries, loaded }] of projects) {
        await pushProject({
            deps,
            items: entries.map(({ item }) => item),
            project,
            layers: loaded.rules.layers,
            mode,
            report,
        });
    }
}

/** One push the plan made: the item's facts now, and the items whose outside keys it names (parent, links). */
interface Planned {
    intent: PushIntent;
    generation: number | null;
    waitsFor: ItemId[];
    references: Reference[];
}

/** New items the plan did not make outside, by reason; they become the report's notes. */
interface LeftOut {
    noCreateTypes: number;
    handoffTasks: number;
    notUnder: number;
}

function planPushes(input: {
    deps: SyncDeps;
    items: Item[];
    mode: PushMode;
    project: string;
    connectorId: string;
    connector: Connector<unknown>;
    config: ConnectorConfig;
    report: SyncReport;
}): { planned: Planned[]; left: LeftOut } {
    const { deps, items, mode, project, connectorId: id, connector, config, report } = input;
    const { db } = deps;
    const view = sqlView(db);
    const live = mode.kind !== "sync" || !mode.preview;
    const planned: Planned[] = [];
    const left: LeftOut = { noCreateTypes: 0, handoffTasks: 0, notUnder: 0 };

    for (const candidate of items) {
        const item = selectItem(db, candidate.id);

        if (item === null || item.project !== project) {
            continue;
        }

        const pairing = selectPairings(db, { item: item.id, connector: id })[0] ?? null;
        const canCreate = connector.can.create && config.createTypes.includes(item.type);
        if (mode.kind === "sync" && mode.all && !mode.touched.has(item.id) && pairing === null) {
            continue;
        }

        if (mode.kind === "release" && pairing?.state !== "held") {
            continue;
        }

        if (
            mode.kind === "resolve" &&
            (pairingGeneration(db, item.id, id) !== mode.generation || pairing?.remoteKey !== mode.remoteKey)
        ) {
            throw new Error(`${item.id}: pairing changed before resolution push; retry resolution.`);
        }
        if ((mode.kind === "pair" || mode.kind === "resolve") && pairing === null) {
            continue;
        }

        if (!pairing?.remoteKey) {
            if (!canCreate) {
                if (connector.can.create && config.createTypes.length === 0) {
                    left.noCreateTypes++;
                }

                continue;
            }

            const out = outOfScope(view, item, config.scope);

            if (out !== null) {
                if (out === "handoff-task") {
                    left.handoffTasks++;
                } else {
                    left.notUnder++;
                }

                continue;
            }
        }

        if (mode.kind === "sync") {
            // A held item comes back in every pass, so a later sync still says why it was not made or updated.
            if (
                !mode.touched.has(item.id) &&
                !(mode.all && pairing) &&
                pairing?.state !== "held" &&
                (pairing?.state !== "failed" || pairing.updatedTs > mode.retryBefore)
            ) {
                continue;
            }

            const own = config.push(item.type);
            const rule = own ?? defaultPush(item.type);
            const actors = rule === "anyone" ? [] : pushActors(db, item.id, mode.cursor, own !== undefined);
            const blocked = actors.some(
                (actor) =>
                    !allows(
                        rule,
                        rolesOf(view, item, {
                            lineage: actor.sessionId !== null ? [actor.sessionId] : [],
                            ownerKind: actor.kind === "owner",
                            sessionId: actor.sessionId,
                        })
                    )
            );

            if (pairing?.state === "held" || blocked) {
                if (live && pairing?.state !== "held") {
                    writePairing(db, deps, {
                        ...(pairing ?? newPairing(item.id, id, deps.now())),
                        state: "held",
                        note: noteOf({ reason: HELD_NOTE, local: pairing ? localDriftFacts(pairing) : [] }),
                    });
                }

                report.held++;
                report.preview?.hold.push(item.id);
                addProblem(report, {
                    item: item.id,
                    connector: id,
                    state: "held",
                    note: `${pairing?.state === "held" ? (reasonOf(pairing) ?? HELD_NOTE) : HELD_NOTE}; release it with \`sync --release ${item.id}\``,
                });
                continue;
            }
        }

        const machine = deps.machinePrefix;
        const labels = [item.id, ...containersOf(db, item.id)].map((target) =>
            pairingLabelFor(config.labelTemplate || DEFAULT_LABEL_TEMPLATE, {
                machine,
                project: item.project,
                id: target,
            })
        );
        planned.push({
            intent: { item, pairing, labels, ...(mode.kind === "resolve" ? { force: mode.force } : {}) },
            generation: pairingGeneration(db, item.id, id),
            waitsFor: referencedItems(db, item.id),
            references: selectRefsFrom(db, item.id),
        });
    }

    return { planned, left };
}

function noteLeftOut(report: SyncReport, where: string, left: LeftOut): void {
    if (left.noCreateTypes > 0) {
        addNote(report, `${where}: ${left.noCreateTypes} new item(s) not made outside, because createTypes is empty`);
    }

    if (left.handoffTasks > 0) {
        addNote(
            report,
            `${where}: ${left.handoffTasks} handoff task(s) not made outside, because scope.handoffTasks is off`
        );
    }

    if (left.notUnder > 0) {
        addNote(report, `${where}: ${left.notUnder} new item(s) not made outside, outside scope.under and scope.tags`);
    }
}

/**
 * Waves: an item goes after the items it names (its parent, its link targets) when those have no outside key yet,
 * so a child's first push carries its parent's key. Cyclic links retry after the parent-first creation waves.
 */
function* pushWaves(planned: readonly Planned[]): Generator<Planned[]> {
    const pending = new Map(planned.map((entry) => [entry.intent.item.id, entry]));
    const unmade = new Set(
        planned.filter((entry) => !entry.intent.pairing?.remoteKey).map((entry) => entry.intent.item.id)
    );
    const counts = new Map<ItemId, number>();
    const dependents = new Map<ItemId, Planned[]>();
    let ready: Planned[] = [];
    for (const entry of planned) {
        const dependencies = [...new Set(entry.waitsFor.filter((id) => id !== entry.intent.item.id && unmade.has(id)))];
        counts.set(entry.intent.item.id, dependencies.length);
        if (!dependencies.length) {
            ready.push(entry);
        }
        for (const id of dependencies) {
            const waiting = dependents.get(id) ?? [];
            waiting.push(entry);
            dependents.set(id, waiting);
        }
    }
    while (pending.size) {
        if (!ready.length) {
            // Parent edges are acyclic. A link cycle can wait until both endpoints exist.
            ready = [...pending.values()].filter((entry) =>
                entry.references.filter((ref) => ref.kind === "parent").every((ref) => !pending.has(ref.to))
            );
        }
        if (!ready.length) {
            throw new Error("Cannot order publication parents: cyclic parent references");
        }
        const wave = ready;
        ready = [];
        for (const entry of wave) {
            pending.delete(entry.intent.item.id);
        }
        yield wave;
        for (const entry of wave) {
            for (const dependent of dependents.get(entry.intent.item.id) ?? []) {
                if (!pending.has(dependent.intent.item.id)) {
                    continue;
                }
                const count = (counts.get(dependent.intent.item.id) ?? 0) - 1;
                counts.set(dependent.intent.item.id, count);
                if (count === 0) {
                    ready.push(dependent);
                }
            }
        }
    }
}

async function pushProject({
    deps,
    items,
    project,
    layers,
    mode,
    report,
}: {
    deps: SyncDeps;
    items: Item[];
    mode: PushMode;
    project: string;
    layers: readonly RuleLayerInput[];
    report: SyncReport;
}): Promise<void> {
    const { db } = deps;
    const live = mode.kind !== "sync" || !mode.preview;

    for (const [id, connector] of Object.entries(deps.connectors)) {
        if ((mode.kind === "pair" || mode.kind === "resolve") && mode.connector !== id) {
            continue;
        }

        const { config, problems } = connectorConfigOf(layers, id);

        if (problems.length > 0) {
            logger.warn({ connector: id, project, problems }, "work sync: invalid connector configuration");
        }

        if (!config?.enabled) {
            continue;
        }

        if (mode.kind === "sync" && live && !renewLease(db, mode.lease, deps.now())) {
            return;
        }

        const input = { deps, items, mode, project, connectorId: id, connector, config, report };
        let plan: ReturnType<typeof planPushes> = {
            planned: [],
            left: { noCreateTypes: 0, handoffTasks: 0, notUnder: 0 },
        };

        if (live) {
            inTransaction(db, () => {
                plan = planPushes(input);
            });
        } else {
            plan = planPushes(input);
        }

        noteLeftOut(report, `${id} in ${project}`, plan.left);

        if (!live) {
            for (const { intent } of plan.planned) {
                (intent.pairing?.remoteKey ? report.preview?.update : report.preview?.create)?.push(intent.item.id);
            }

            continue;
        }

        for (const scheduled of pushWaves(plan.planned)) {
            const wave: Planned[] = [];

            if (mode.kind === "sync" && !renewLease(db, mode.lease, deps.now())) {
                return;
            }

            const incompleteLinks: Planned[] = [];
            for (const entry of scheduled) {
                const { intent, references } = entry;
                const refs = outsideRefs(db, intent.item.id, id, references);
                const parent = references.find((ref) => ref.kind === "parent");
                if (connector.can.parents && parent && refs.parentKey === undefined && !intent.pairing?.remoteKey) {
                    const note = "parent has no outside key; retry after its creation";
                    writePairing(db, deps, {
                        ...(intent.pairing ?? newPairing(intent.item.id, id, deps.now())),
                        state: "failed",
                        note,
                    });
                    report.failed++;
                    addProblem(report, { item: intent.item.id, connector: id, state: "failed", note });
                    continue;
                }
                if (connector.can.parents) {
                    intent.parentKey = parent ? refs.parentKey : null;
                }
                if (connector.can.links) {
                    intent.links = refs.links;
                    const links = references.filter((ref) => ref.kind !== "parent" && entry.waitsFor.includes(ref.to));
                    if ((refs.links?.length ?? 0) < links.length) {
                        incompleteLinks.push(entry);
                    }
                }
                wave.push(entry);
            }
            if (wave.length) {
                await pushWave({ deps, connectorId: id, connector, config, project, mode, wave, report });
            }
            for (const { intent } of incompleteLinks) {
                const current = selectPairings(db, { item: intent.item.id, connector: id })[0];
                if (current && current.state !== "failed") {
                    const note = "linked target has no outside key; retry after its creation";
                    writePairing(db, deps, {
                        ...current,
                        state: "failed",
                        note: noteOf({
                            reason: note,
                            remote: factsChangedOutside(current),
                            local: localDriftFacts(current),
                        }),
                    });
                    report.failed++;
                    addProblem(report, { item: intent.item.id, connector: id, state: "failed", note });
                }
            }
        }
    }
}

async function pushWave({
    deps,
    connectorId: id,
    connector,
    config,
    project,
    mode,
    wave,
    report,
}: {
    deps: SyncDeps;
    connectorId: string;
    connector: Connector<unknown>;
    config: ConnectorConfig;
    project: string;
    mode: PushMode;
    wave: readonly Planned[];
    report: SyncReport;
}): Promise<void> {
    const { db } = deps;
    const intents = wave.map(({ intent }) => intent);
    const ctx: ConnectorContext = {
        settings: config.settings,
        project,
        machinePrefix: deps.machinePrefix,
        ...(mode.kind === "sync" ? { keepAlive: () => renewLease(db, mode.lease, deps.now()) } : {}),
    };
    const results = await connector.push(intents, ctx).catch((error: unknown): PushResult[] => {
        logger.warn({ connector: id, project, err: error }, "work sync: connector push failed");
        return intents.map(() => ({
            ok: false as const,
            error: error instanceof Error ? error.message : String(error),
        }));
    });

    inTransaction(db, () => {
        if (mode.kind === "sync" && !renewLease(db, mode.lease, deps.now())) {
            return;
        }

        wave.forEach(({ intent, generation }, index) => {
            if (pairingGeneration(db, intent.item.id, id) !== generation) {
                return;
            }

            const result = results[index] ?? { ok: false as const, error: "the connector answered no result" };
            const base = intent.pairing ?? newPairing(intent.item.id, id, deps.now());
            const local = localDriftFacts(base);

            if (result.ok) {
                const outside = result.changedOutside ?? [];
                const sent = result.sent !== undefined ? { ...base.sent, ...result.sent } : base.sent;
                writePairing(db, deps, {
                    ...base,
                    remoteKey: result.remoteKey,
                    ...(sent !== undefined ? { sent } : {}),
                    state: local.length > 0 || outside.length > 0 ? "drift" : "in-sync",
                    note: noteOf({ remote: outside.map(({ fact }) => fact), local }),
                });
                report.pushed++;

                if (outside.length > 0) {
                    report.drift++;
                    addProblem(report, {
                        item: intent.item.id,
                        connector: id,
                        state: "drift",
                        note: changedOutsideNote(intent.item.id, outside),
                    });
                }
            } else {
                writePairing(db, deps, {
                    ...base,
                    remoteKey: result.remoteKey ?? base.remoteKey,
                    ...(result.sent !== undefined ? { sent: { ...base.sent, ...result.sent } } : {}),
                    state: "failed",
                    note: noteOf({
                        reason: result.error,
                        remote: [
                            ...new Set([
                                ...factsChangedOutside(base),
                                ...(result.changedOutside ?? []).map(({ fact }) => fact),
                            ]),
                        ],
                        local,
                    }),
                });
                report.failed++;
                addProblem(report, { item: intent.item.id, connector: id, state: "failed", note: result.error });
            }
        });
    });
}

/** A failed or held pairing's note starts with its reason, kept to one line so it never reads as a drift line. */
function hasReasonLine(pairing: Pick<Pairing, "state">): boolean {
    return pairing.state === "failed" || pairing.state === "held";
}

/**
 * The facts of a pairing's local-drift line: facts the outside owns that were changed here. A push never sends them, so
 * a successful push leaves that difference in place and the pairing stays drift; a remote-drift line (a fact owned
 * here) is settled by the push. The reason line of a failed or held pairing is skipped, so a connector error that
 * happens to start with the drift prefix is never read as drift.
 */
function localDriftFacts(pairing: Pick<Pairing, "state" | "note">): SyncedFact[] {
    const lines = (pairing.note ?? "").split("\n").slice(hasReasonLine(pairing) ? 1 : 0);
    const named = lines
        .filter((line) => line.startsWith(DRIFT_NOTE_PREFIX.local))
        .flatMap((line) => line.slice(DRIFT_NOTE_PREFIX.local.length).split(","))
        .map((word) => word.trim());
    return SYNCED_FACTS.filter((fact) => named.includes(fact));
}

/** The reason line of a failed or held pairing's note, when it has one. */
function reasonOf(pairing: Pick<Pairing, "state" | "note">): string | undefined {
    return hasReasonLine(pairing) ? pairing.note?.split("\n")[0] || undefined : undefined;
}

/** A pairing note from its parts: a one-line reason first, then a remote-drift and a local-drift line. */
function clip(value: string): string {
    const flat = value.replace(/\s+/g, " ").trim();
    return flat.length > 60 ? `${flat.slice(0, 59)}…` : flat;
}

/** The warning of a push that left facts changed outside: each fact with both values, and how to settle it. */
function changedOutsideNote(item: ItemId, outside: readonly FactChangedOutside[]): string {
    const facts = outside.map(
        ({ fact, outside: there, here }) => `${fact} (outside "${clip(there)}", here "${clip(here)}")`
    );
    return `changed outside since the last sync, not overwritten: ${facts.join("; ")}; keep one side with \`sync --resolve ${item} --take ours|theirs\``;
}

/** The facts a drift note names as changed outside (its `changed outside, owned here:` line). */
function factsChangedOutside(pairing: Pick<Pairing, "note">): SyncedFact[] {
    const line = (pairing.note ?? "").split("\n").find((one) => one.startsWith(DRIFT_NOTE_PREFIX.remote));
    const named = line?.slice(DRIFT_NOTE_PREFIX.remote.length).split(",") ?? [];
    return SYNCED_FACTS.filter((fact) => named.some((one) => one.trim() === fact));
}

/** Adds a note for the pairings still in drift, so every pass says which items differ outside and here. */
export function noteStandingDrift(db: Database, report: SyncReport): SyncReport {
    const drifted = db
        .query<{ item: ItemId }, []>(
            "SELECT item FROM pairings WHERE state = 'drift' OR (state = 'failed' AND instr(origin, 'changed outside, owned here:') > 0) ORDER BY updated_ts"
        )
        .all()
        .map(({ item }) => item);

    if (drifted.length > 0) {
        const shown = drifted.slice(0, 10).join(", ");
        const more = drifted.length > 10 ? ` and ${drifted.length - 10} more` : "";
        addNote(
            report,
            `${drifted.length} item(s) differ outside and here (${shown}${more}): keep one side with \`sync --resolve <id> --take ours|theirs\``
        );
    }

    return report;
}

function noteOf({
    reason,
    remote = [],
    local = [],
}: {
    reason?: string;
    remote?: readonly SyncedFact[];
    local?: readonly SyncedFact[];
}): string | undefined {
    const lines = [
        reason?.replace(/\s+/g, " ").trim() || undefined,
        remote.length > 0 ? `${DRIFT_NOTE_PREFIX.remote} ${remote.join(", ")}` : undefined,
        local.length > 0 ? `${DRIFT_NOTE_PREFIX.local} ${local.join(", ")}` : undefined,
    ].filter((line): line is string => line !== undefined);
    return lines.length > 0 ? lines.join("\n") : undefined;
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
                const local = localDriftFacts(pairing);
                inTransaction(deps.db, () =>
                    writePairing(deps.db, deps, {
                        ...pairing,
                        state: hasReasonLine(pairing) ? pairing.state : "drift",
                        note: noteOf({
                            reason: reasonOf(pairing),
                            remote: factsChangedOutside(pairing),
                            local: SYNCED_FACTS.filter((fact) => local.includes(fact) || owned.includes(fact)),
                        }),
                    })
                );
                report.drift++;
            }
        }
    }
}

export interface SyncOptions {
    /** Push every paired item again, not only the changed ones (after a connector learns a new fact, such as parents). */
    all?: boolean;
}

function pairedItems(db: Database): ItemId[] {
    return db
        .query<{ item: ItemId }, []>("SELECT DISTINCT item FROM pairings")
        .all()
        .map(({ item }) => item);
}

function heldItems(db: Database): ItemId[] {
    return db
        .query<{ item: ItemId }, [number]>("SELECT DISTINCT item FROM pairings WHERE state = 'held' LIMIT ?")
        .all(BATCH)
        .map(({ item }) => item);
}

function failedBefore(db: Database, retryBefore: string): ItemId[] {
    return db
        .query<{ item: ItemId }, [string, number]>(
            "SELECT DISTINCT item FROM pairings WHERE state = 'failed' AND updated_ts <= ? ORDER BY updated_ts LIMIT ?"
        )
        .all(retryBefore, BATCH)
        .map(({ item }) => item);
}

/**
 * What `runSyncOnce` would do now, without its lease and without a write or a connector call: the items it would
 * make outside, update or hold, and its notes. The cursor does not move.
 */
export async function previewSync(deps: SyncDeps, options: SyncOptions = {}): Promise<SyncReport> {
    const { db } = deps;
    const report: SyncReport = {
        pushed: 0,
        held: 0,
        failed: 0,
        drift: 0,
        cursor: -1,
        preview: { create: [], update: [], hold: [] },
    };
    const start =
        db.query<{ seq: number }, [string]>("SELECT seq FROM cursors WHERE consumer = ?").get(CURSOR)?.seq ?? 0;
    const retryBefore = new Date(Date.parse(deps.now()) - RETRY_AFTER_MS).toISOString();
    const highWater = journalHead(db);
    report.cursor = highWater;
    let after = "";
    const changed =
        "EXISTS (SELECT 1 FROM changes c WHERE c.item = i.id AND c.seq > ? AND c.seq <= ? AND json_extract(c.origin, '$.via') <> 'connector')";
    for (;;) {
        const candidates = db
            .query<{ item: ItemId; touched: number }, [number, number, string, number, number, number, string, number]>(
                `SELECT i.id AS item, ${changed} AS touched FROM items i
            WHERE i.id > ? AND (${changed} OR EXISTS (
                SELECT 1 FROM pairings p WHERE p.item = i.id AND
                (? = 1 OR p.state = 'held' OR (p.state = 'failed' AND p.updated_ts <= ?))))
            ORDER BY i.id LIMIT ?`
            )
            .all(start, highWater, after, start, highWater, options.all ? 1 : 0, retryBefore, BATCH);
        if (!candidates.length) {
            break;
        }
        const touched = new Set(candidates.filter((entry) => entry.touched).map((entry) => entry.item));
        const items = candidates.map(({ item }) => selectItem(db, item)).filter((item) => item !== null);
        await pushItems({
            deps,
            items,
            mode: { kind: "sync", cursor: start, lease: "", touched, retryBefore, preview: true, all: options.all },
            report,
        });
        after = candidates.at(-1)?.item ?? after;
    }
    return report;
}

/** Drain committed journal pages under one lease. Release only after atomically checking for more entries. */
export async function runSyncOnce(deps: SyncDeps, options: SyncOptions = {}): Promise<SyncReport> {
    const { db } = deps;
    const now = deps.now();
    const lease = `${deps.owner}:${randomUUID()}`;

    if (!takeLease(db, lease, now)) {
        return { pushed: 0, held: 0, failed: 0, drift: 0, skipped: "lease", cursor: -1 };
    }

    const report: SyncReport = { pushed: 0, held: 0, failed: 0, drift: 0, cursor: 0 };

    try {
        let cursor = (db.query("SELECT seq FROM cursors WHERE consumer = ?").get(CURSOR) as { seq: number }).seq;
        const retryBefore = new Date(Date.parse(now) - RETRY_AFTER_MS).toISOString();
        let retryFailed = true;
        for (;;) {
            const changes = selectChangesAfter(db, cursor, BATCH);
            const forced = retryFailed && options.all === true ? pairedItems(db) : [];
            const touched = new Set<ItemId>();

            for (const change of changes) {
                // A change a connector made (a pull, a pairing) is not pushed back.
                if (change.origin.via !== "connector") {
                    touched.add(change.item);
                }
            }

            const retries = retryFailed ? [...failedBefore(db, retryBefore), ...heldItems(db)] : [];
            retryFailed = false;
            const ids = new Set([...forced, ...touched, ...retries]);
            const items = [...ids].map((id) => selectItem(db, id)).filter((item) => item !== null);
            await pushItems({
                deps,
                items,
                mode: { kind: "sync", cursor, lease, touched, retryBefore, preview: false, all: options.all },
                report,
            });

            if (!renewLease(db, lease, deps.now())) {
                return { ...report, cursor, skipped: "lease" };
            }

            markLocalDrift(deps, changes, report);
            cursor = changes.at(-1)?.seq ?? cursor;
            report.cursor = cursor;
            const more = db
                .transaction(() => {
                    const updated = db.run(
                        "UPDATE cursors SET seq = ? WHERE consumer = ? AND lease_owner = ? AND lease_until > ?",
                        [cursor, CURSOR, lease, deps.now()]
                    );
                    if (updated.changes === 0) {
                        report.skipped = "lease";
                        return false;
                    }
                    if (db.query("SELECT 1 FROM changes WHERE seq > ? LIMIT 1").get(cursor) !== null) {
                        return true;
                    }
                    dropLease(db, lease);
                    return false;
                })
                .immediate();
            if (!more) {
                return report;
            }
        }
    } finally {
        dropLease(db, lease);
    }
}

/** `sync --release <ref>`: push a held change now, whatever role made it. */
export async function releaseHeld(deps: SyncDeps, item: ItemId): Promise<SyncReport> {
    return pushExplicit(deps, item, { kind: "release" });
}

/** Pair pushes only to the connector the caller selected. */
export async function pushPairing(input: { deps: SyncDeps; item: ItemId; connector: string }): Promise<SyncReport> {
    return pushExplicit(input.deps, input.item, { kind: "pair", connector: input.connector });
}

export type ResolveSide = "ours" | "theirs";

/**
 * `sync --resolve <ref> --take ours|theirs`: settle a pairing in drift. Ours writes the named facts outside whatever
 * it holds; theirs copies the outside title, text, type and state here, then pushes so both sides agree. With no
 * facts named, the facts its drift note names (ours: every fact when the note names none).
 */
export async function resolveDrift(
    deps: SyncDeps,
    {
        item,
        take,
        facts,
        connector: connectorId,
    }: { item: ItemId; take: ResolveSide; facts?: readonly SyncedFact[]; connector?: string }
): Promise<SyncReport> {
    const { db } = deps;
    const pairings = selectPairings(db, { item, connector: connectorId }).filter((pairing) => pairing.remoteKey !== "");
    const pairing = pairings.find((one) => one.state === "drift") ?? pairings[0];
    const row = selectItem(db, item);

    if (pairing === undefined || row === null) {
        throw new Error(`${item} has no pairing to resolve.`);
    }

    const connector = Object.hasOwn(deps.connectors, pairing.connector)
        ? deps.connectors[pairing.connector]
        : undefined;

    if (connector === undefined) {
        throw new Error(`The connector ${pairing.connector} of ${item} is not available.`);
    }

    const generation = pairingGeneration(db, item, pairing.connector);
    const noted = [...new Set([...factsChangedOutside(pairing), ...localDriftFacts(pairing)])];
    const named = facts ?? (noted.length > 0 || take === "theirs" ? noted : SYNCED_FACTS);
    const report: SyncReport = { pushed: 0, held: 0, failed: 0, drift: 0, cursor: -1 };

    if (take === "theirs") {
        const loaded = await deps.loadRules({ project: row.project });
        const { config } = connectorConfigOf(loaded.rules.layers, pairing.connector);
        const [remote] = await connector.pull(
            { remoteKeys: [pairing.remoteKey] },
            { settings: config?.settings ?? {}, project: row.project, machinePrefix: deps.machinePrefix }
        );

        if (remote === undefined) {
            throw new Error(`The outside item ${pairing.remoteKey} of ${item} did not answer.`);
        }

        const set: ItemPatch = {};
        const left: SyncedFact[] = [];

        for (const fact of named) {
            if (fact === "title" && remote.title !== undefined) {
                set.title = remote.title;
            } else if (fact === "body" && remote.body !== undefined) {
                set.body = remote.body;
            } else if (fact === "type" && remote.type !== undefined) {
                set.type = remote.type;
            } else if (fact === "tags" && remote.tags !== undefined) {
                set.tags = remote.tags;
            } else if (fact === "severity" && remote.severity !== undefined) {
                set.severity = remote.severity;
            } else if (fact !== "state" || remote.state === undefined) {
                left.push(fact);
            }
        }

        const actor = CONNECTOR_ACTOR(pairing.connector);
        const origin = { via: "connector" as const, id: pairing.connector };
        inTransaction(db, () => {
            if (
                selectItem(db, item)?.rev !== row.rev ||
                pairingGeneration(db, item, pairing.connector) !== generation
            ) {
                throw new Error(`${item}: item or pairing changed during the outside read; retry resolution.`);
            }
            if (Object.keys(set).length > 0) {
                applyChange(db, { v: 1, ts: deps.now(), item, actor, origin, kind: "edited", payload: { set } });
            }

            if (named.includes("state") && remote.state !== undefined && remote.state !== row.state) {
                applyChange(db, {
                    v: 1,
                    ts: deps.now(),
                    item,
                    actor,
                    origin,
                    kind: "moved",
                    payload: { from: row.state, to: remote.state, why: "taken from outside by sync --resolve" },
                });
            }
            const resolved = named.filter((fact) => !left.includes(fact));
            const remainingRemote = factsChangedOutside(pairing).filter((fact) => !resolved.includes(fact));
            const remainingLocal = localDriftFacts(pairing).filter((fact) => !resolved.includes(fact));
            writePairing(db, deps, {
                ...pairing,
                state: remainingRemote.length || remainingLocal.length ? "drift" : "pending",
                note: noteOf({ remote: remainingRemote, local: remainingLocal }),
            });
        });

        if (left.length > 0) {
            report.failed++;
            addProblem(report, {
                item,
                connector: pairing.connector,
                state: "failed",
                note: `Cannot take unsupported or missing outside facts: ${left.join(", ")}`,
            });
            addNote(
                report,
                `${item}: the outside answer gives no ${left.join(", ")} to take; keep ours or edit it here`
            );
        }
    }

    const pushed = await pushExplicit(deps, item, {
        kind: "resolve",
        connector: pairing.connector,
        force: take === "ours" ? named : [],
        generation: take === "ours" ? generation : pairingGeneration(db, item, pairing.connector),
        remoteKey: pairing.remoteKey,
    });
    return {
        ...pushed,
        failed: pushed.failed + report.failed,
        problems: [...(report.problems ?? []), ...(pushed.problems ?? [])],
        notes: [...(report.notes ?? []), ...(pushed.notes ?? [])],
    };
}

async function pushExplicit(deps: SyncDeps, item: ItemId, mode: PushMode): Promise<SyncReport> {
    const report: SyncReport = { pushed: 0, held: 0, failed: 0, drift: 0, cursor: -1 };
    const row = selectItem(deps.db, item);

    if (row !== null) {
        await pushItems({ deps, items: [row], mode, report });
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
    { connector: connectorId, remoteKeys }: { connector: string; remoteKeys: readonly string[] }
): Promise<PullReport> {
    const connector = Object.hasOwn(deps.connectors, connectorId) ? deps.connectors[connectorId] : undefined;
    const report: PullReport = { made: [], updated: [], drift: [] };

    if (connector === undefined || !connector.can.pull) {
        throw new Error(`Connector ${connectorId} does not support pull.`);
    }

    const loaded = await deps.loadRules({ project: deps.project });
    const { config, problems } = connectorConfigOf(loaded.rules.layers, connectorId);

    if (!config?.enabled) {
        throw new Error(problems.join("; ") || `Connector ${connectorId} is disabled in ${deps.project}.`);
    }

    const remotes = await connector.pull(
        { remoteKeys },
        { settings: config.settings, project: deps.project, machinePrefix: deps.machinePrefix }
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
            // Facts the outside owns that this pull leaves equal to the remote: their local drift is resolved.
            const settled: SyncedFact[] = [];

            for (const fact of SYNCED_FACTS) {
                const theirs = remoteFact(remote, fact);

                const matches =
                    fact === "state" && connector.stateMatches !== undefined
                        ? connector.stateMatches(remote, item.state)
                        : SafeJSON.stringify(theirs) === SafeJSON.stringify(factOf(item, fact));

                if (theirs !== undefined && pairing.origin[fact] === "remote") {
                    settled.push(fact);
                }

                if (theirs === undefined || matches) {
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

            const before = localDriftFacts(pairing);
            const local = before.filter((fact) => !settled.includes(fact));

            if (drifted.length > 0) {
                writePairing(db, deps, {
                    ...pairing,
                    state: "drift",
                    note: noteOf({ remote: drifted, local }),
                });
                report.drift.push(item.id);
            } else if (local.length < before.length) {
                const keep = hasReasonLine(pairing) || pairing.state === "pending";
                writePairing(db, deps, {
                    ...pairing,
                    state: keep ? pairing.state : local.length > 0 ? "drift" : "in-sync",
                    note: noteOf({ reason: reasonOf(pairing), local }),
                });
            }
        }
    });

    return report;
}

/** `pair <ref> <connector> <key>`: one more pairing row on a local item; the next push brings the label outside. */
export function pairItem(
    deps: Pick<SyncDeps, "db" | "now">,
    {
        item,
        connector,
        remoteKey,
        state = "pending",
    }: {
        item: ItemId;
        connector: string;
        remoteKey: string;
        state?: Pairing["state"];
    }
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
export function unpairItem(
    deps: Pick<SyncDeps, "db" | "now">,
    { item, connector }: { item: ItemId; connector: string }
): boolean {
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
