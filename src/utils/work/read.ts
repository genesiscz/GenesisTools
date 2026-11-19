/** The reads of the work store. Each one is a pure read: it never writes a row, a cursor or a journal entry. */
import type { Database } from "bun:sqlite";
import type { NextAction } from "@genesiscz/utils/output/reply";
import type { Change } from "./model/change";
import type { Item, ItemId, Pointer, Reference, WorkerStamp } from "./model/item";
import { asItemId, stampOf } from "./model/item";
import type { ItemState, ItemType, Severity } from "./model/vocab";
import { isOpenState } from "./model/vocab";
import { selectItem } from "./store/rows";
import { type ListFilter, type StoreView, selectItems, sqlView } from "./store/view";

export interface ListQuery extends ListFilter {
    /** Members of a handoff, or children of an item in the plan tree. */
    under?: string;
    /** Items spotted during this handoff or during one of its members. */
    spottedIn?: string;
}

export interface ItemRow {
    ref: string;
    state: ItemState;
    type: ItemType;
    severity?: Severity;
    worker?: string;
    title: string;
    project: string;
    slot?: string;
}

export function workerLabel(worker: WorkerStamp | undefined): string | undefined {
    if (worker === undefined) {
        return undefined;
    }

    const session = worker.sessionId ? worker.sessionId.slice(0, 8) : "?";
    return `${worker.harness} ${session}`;
}

export function toRow(item: Item, slot?: string): ItemRow {
    return {
        ref: item.id,
        state: item.state,
        type: item.type,
        ...(item.severity !== undefined ? { severity: item.severity } : {}),
        ...(item.worker !== undefined ? { worker: workerLabel(item.worker) } : {}),
        title: item.title,
        project: item.project,
        ...(slot !== undefined ? { slot } : {}),
    };
}

function idsUnder(db: Database, ref: string): { ids: string[]; slots: Map<string, string> } | null {
    const view = sqlView(db);
    const resolved = view.resolve(ref);

    if (resolved === null) {
        return null;
    }

    const slots = new Map<string, string>();
    const ids: string[] = [];

    for (const r of view.refsFrom(resolved.item.id)) {
        if (r.kind === "member") {
            ids.push(r.to);
            slots.set(r.to, r.slot ?? "");
        }
    }

    for (const r of view.refsTo(resolved.item.id)) {
        if (r.kind === "parent") {
            ids.push(r.from);
        }
    }

    return { ids, slots };
}

function idsSpottedIn(db: Database, ref: string): string[] | null {
    const view = sqlView(db);
    const resolved = view.resolve(ref);

    if (resolved === null) {
        return null;
    }

    const targets = new Set<string>([resolved.item.id]);

    for (const r of view.refsFrom(resolved.item.id)) {
        if (r.kind === "member") {
            targets.add(r.to);
        }
    }

    const placeholders = [...targets].map(() => "?").join(", ");
    return (
        db
            .query(`SELECT from_id FROM refs WHERE kind = 'spotted-in' AND to_id IN (${placeholders}) ORDER BY id`)
            .all(...targets) as { from_id: string }[]
    ).map((row) => row.from_id);
}

export type ListResult = { ok: true; rows: ItemRow[] } | { ok: false; missing: string };

export function listItems(db: Database, query: ListQuery): ListResult {
    const filter: ListFilter = { ...query };
    let slots = new Map<string, string>();

    if (query.under !== undefined) {
        const under = idsUnder(db, query.under);

        if (under === null) {
            return { ok: false, missing: query.under };
        }

        filter.ids = intersect(filter.ids, under.ids);
        slots = under.slots;
    }

    if (query.spottedIn !== undefined) {
        const spotted = idsSpottedIn(db, query.spottedIn);

        if (spotted === null) {
            return { ok: false, missing: query.spottedIn };
        }

        filter.ids = intersect(filter.ids, spotted);
    }

    if (filter.ids !== undefined && filter.ids.length === 0) {
        return { ok: true, rows: [] };
    }

    const rows = selectItems(db, filter).map((item) => toRow(item, slots.get(item.id)));

    if (slots.size > 0) {
        rows.sort((a, b) => slotOrder(a.slot) - slotOrder(b.slot));
    }

    return { ok: true, rows };
}

function slotOrder(slot: string | undefined): number {
    const n = slot !== undefined ? Number.parseInt(slot.replace(/^\D+/, ""), 10) : Number.NaN;
    return Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER;
}

function intersect(current: string[] | undefined, next: string[]): string[] {
    const ids = new Set(next);
    return current === undefined ? next : current.filter((id) => ids.has(id));
}

export interface ShowResult {
    item: Item;
    refs: { out: Reference[]; in: Reference[] };
    pointers: Pointer[];
    log: Change[];
    members?: ItemRow[];
}

export function showItem(db: Database, ref: string): ShowResult | null {
    const view = sqlView(db);
    const resolved = view.resolve(ref);

    if (resolved === null) {
        return null;
    }

    const item = resolved.item;
    const out = view.refsFrom(item.id);
    const result: ShowResult = {
        item,
        refs: { out, in: view.refsTo(item.id) },
        pointers: view.pointers(item.id),
        log: view.changes(item.id),
    };

    if (item.type === "handoff" || item.type === "epic") {
        const listed = listItems(db, { under: item.id });
        result.members = listed.ok ? listed.rows : [];
    }

    return result;
}

/** The worker a reopen goes to: the last finisher, else the last claimer of the item or of a handoff that holds it. */
export function workerOf(db: Database, id: ItemId): WorkerStamp | null {
    const view = sqlView(db);
    const item = view.item(id);

    if (item === null) {
        return null;
    }

    const finished = [...view.changes(id)]
        .reverse()
        .find((c) => c.kind === "moved" && (c.payload as { to?: string }).to === "done" && c.actor.kind !== "legacy");

    if (finished !== undefined) {
        return stampOf(finished.actor);
    }

    return latestClaim(view, item, false) ?? item.worker ?? null;
}

function latestClaim(view: StoreView, item: Item, activeOnly: boolean): WorkerStamp | null {
    const claims = [item.id, ...view.memberships(item.id).map(({ handoff }) => handoff)].flatMap((id) =>
        view.claims({ item: id, ...(activeOnly ? { active: true } : {}) })
    );
    claims.sort((a, b) => Number(b.active) - Number(a.active) || b.ts.localeCompare(a.ts));
    return claims[0]?.by ?? null;
}

export type TriageGroup = "spotted" | "reopened-no-worker" | "active-worker-gone" | "spotted-in-finished";

export interface TriageRow {
    ref: string;
    group: TriageGroup;
    type: ItemType;
    state: ItemState;
    title: string;
    where?: string;
    why?: string;
    userSees?: string;
    severity?: Severity;
    spottedIn?: { ref: string; title: string; state: ItemState };
    spottedBy?: string;
    worker?: string;
    next: NextAction[];
}

/** Answers whether a session is alive: true, false, or null when nobody can tell. */
export type Liveness = (sessionId: string, harness: string) => Promise<boolean | null>;

function triageNext(item: Item, group: TriageGroup): NextAction[] {
    const ref = item.id;

    if (group === "reopened-no-worker" || group === "active-worker-gone") {
        return [
            { do: "hand it to another agent", call: { method: "handoff", params: { title: item.title, from: [ref] } } },
            { do: "drop it with a reason", call: { method: "drop", params: { refs: [ref], why: "<text>" } } },
            { do: "ask the owner who should take it", ask: `Who should take ${ref} (${item.title})?` },
        ];
    }

    return [
        { do: "accept it", call: { method: "accept", params: { refs: [ref] } } },
        { do: "drop it with a reason", call: { method: "drop", params: { refs: [ref], why: "<text>" } } },
        { do: "add it to a handoff", call: { method: "addMember", params: { refs: [ref], to: "<handoff>" } } },
        { do: "make a handoff from these", call: { method: "handoff", params: { title: "<title>", from: [ref] } } },
    ];
}

/** The dangling check: what nobody owns, in four groups, each row with its context and its next actions. */
export async function triage(db: Database, project: string | undefined, alive: Liveness): Promise<TriageRow[]> {
    const view = sqlView(db);
    const rows: TriageRow[] = [];
    const candidates = selectItems(db, {
        ...(project !== undefined ? { project } : {}),
        states: ["spotted", "reopened", "active"],
        limit: 2000,
    });

    for (const item of candidates) {
        if (item.type === "handoff") {
            continue;
        }

        const spottedRef = view.refsFrom(item.id).find((r) => r.kind === "spotted-in");
        const spottedIn = spottedRef !== undefined ? selectItem(db, spottedRef.to) : null;
        let group: TriageGroup | null = null;
        let worker = item.worker ?? null;

        if (item.state === "spotted") {
            group = spottedIn !== null && !isOpenState(spottedIn.state) ? "spotted-in-finished" : "spotted";
        } else {
            const workerFor = (row: Item) =>
                row.state === "active" ? latestClaim(view, row, true) : workerOf(db, row.id);
            worker = workerFor(item);
            const live = worker?.sessionId ? await alive(worker.sessionId, worker.harness) : false;
            const current = view.item(item.id);

            if (current?.rev !== item.rev || current.state !== item.state) {
                continue;
            }

            const currentWorker = workerFor(current);

            if (currentWorker?.sessionId !== worker?.sessionId || currentWorker?.harness !== worker?.harness) {
                continue;
            }

            if (live === false) {
                group = item.state === "reopened" ? "reopened-no-worker" : "active-worker-gone";
            }
        }

        if (group === null) {
            continue;
        }

        rows.push({
            ref: item.id,
            group,
            type: item.type,
            state: item.state,
            title: item.title,
            ...(item.fields.where !== undefined ? { where: item.fields.where } : {}),
            ...(item.fields.why !== undefined ? { why: item.fields.why } : {}),
            ...(item.fields.userSees !== undefined ? { userSees: item.fields.userSees } : {}),
            ...(item.severity !== undefined ? { severity: item.severity } : {}),
            ...(spottedIn !== null
                ? { spottedIn: { ref: spottedIn.id, title: spottedIn.title, state: spottedIn.state } }
                : {}),
            spottedBy: item.createdBy.sessionTitle ?? item.createdBy.sessionId ?? item.createdBy.harness,
            ...(worker !== null ? { worker: workerLabel(worker) } : {}),
            next: triageNext(item, group),
        });
    }

    return rows;
}

export function itemIds(values: string[]): ItemId[] {
    return values.map(asItemId);
}

/** What the widget counts per project (P8 decision 2): items to triage, items reopened, outside changes held. */
export interface ProjectCounts {
    project: string;
    spotted: number;
    reopened: number;
    held: number;
}

/** One pass over the items and one over the pairings; projects with nothing to count are left out. */
export function projectCounts(db: Database): ProjectCounts[] {
    const byProject = new Map<string, ProjectCounts>();
    const row = (project: string): ProjectCounts => {
        let counts = byProject.get(project);

        if (counts === undefined) {
            counts = { project, spotted: 0, reopened: 0, held: 0 };
            byProject.set(project, counts);
        }

        return counts;
    };

    for (const r of db
        .query<{ project: string; spotted: number; reopened: number }, []>(
            "SELECT project, SUM(state = 'spotted') AS spotted, SUM(state = 'reopened') AS reopened FROM items WHERE state IN ('spotted', 'reopened') GROUP BY project"
        )
        .all()) {
        Object.assign(row(r.project), { spotted: r.spotted, reopened: r.reopened });
    }

    for (const r of db
        .query<{ project: string; held: number }, []>(
            "SELECT i.project AS project, COUNT(*) AS held FROM pairings p JOIN items i ON i.id = p.item WHERE p.state = 'held' GROUP BY i.project"
        )
        .all()) {
        row(r.project).held = r.held;
    }

    return [...byProject.values()].sort((a, b) => a.project.localeCompare(b.project));
}
