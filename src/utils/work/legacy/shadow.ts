/**
 * Shadow mode: the old handoff log stays the writer of a handoff's tasks, ticks, claims and text. The old executor
 * calls `ingestLegacyHandoff` after each event it appended, and `tools work migrate backfill` calls it one time for
 * every stored handoff. Both are safe to repeat: an event is applied once, keyed by its uid.
 *
 * The types here are the subset of the old store's shapes that the ingest reads, so the package imports no tool code.
 */
import type { Database } from "bun:sqlite";
import { SafeJSON } from "@genesiscz/utils/json";
import type { NewChange } from "../model/change";
import type { Actor, Item, ItemId } from "../model/item";
import { asItemId } from "../model/item";
import type { CreatedPayload, ItemPatch } from "../model/payloads";
import type { ItemState } from "../model/vocab";
import { applyChange } from "../store/apply";
import { selectItem, selectMemberBySlot } from "../store/rows";

export interface LegacyBy {
    sessionId: string | null;
    sessionTitle: string | null;
    agent: string;
    branch: string | null;
    repoRoot: string | null;
    project: string | null;
    commitSha: string | null;
}

export interface LegacyTaskInput {
    text: string;
    acceptanceCriteria?: string;
    /** The id of an existing work item this task is a copy of (`handoff --from`, `add --under`). */
    item?: string;
}

export interface LegacyTask {
    id: string;
    text: string;
    acceptanceCriteria?: string;
    checked: boolean;
    denied: boolean;
}

export interface LegacyHandoff {
    id: string;
    title: string;
    name?: string;
    description?: string;
    status: "open" | "claimed" | "done" | "cancelled";
    tasks: LegacyTask[];
    target?: { agent?: string; sessionId?: string; sessionName?: string };
    project: string | null;
    postedByContext: LegacyBy;
    createdTs: string;
}

export interface LegacyEvent {
    ev: string;
    uid: string;
    ts: string;
    id: string;
    by: LegacyBy;
    taskId?: string;
    proof?: { answer: string; commitIds?: string[] };
    reason?: string;
    text?: string;
    acceptanceCriteria?: string;
    tasks?: LegacyTaskInput[];
    title?: string;
    description?: string;
    attachmentId?: string;
    filename?: string;
}

export interface LegacyEventRef {
    event: LegacyEvent;
    /** What the old fold decided; null when the read model has no outcome (then the event counts as applied). */
    outcome: { applied: boolean; assignedTaskIds?: string[] } | null;
}

const STATUS_STATE: Record<LegacyHandoff["status"], ItemState> = {
    open: "open",
    claimed: "active",
    done: "done",
    cancelled: "dropped",
};

export function handoffStateOf(status: LegacyHandoff["status"]): ItemState {
    return STATUS_STATE[status];
}

/** The state a task item must have for the old task; null means any open state matches. */
export function taskStateOf(task: Pick<LegacyTask, "checked" | "denied">): ItemState | null {
    if (task.checked) {
        return "done";
    }

    if (task.denied) {
        return "dropped";
    }

    return null;
}

const OPEN_STATES: ReadonlySet<ItemState> = new Set(["open", "active", "reopened"]);

export function legacyActor(by: LegacyBy): Actor {
    return {
        kind: by.agent === "human" ? "owner" : "agent",
        harness: by.agent,
        sessionId: by.sessionId,
        sessionTitle: by.sessionTitle,
        model: null,
        host: null,
        subagentId: null,
        project: by.project,
        repoRoot: by.repoRoot,
        branch: by.branch,
        commitSha: by.commitSha,
    };
}

const RECONCILER: Actor = {
    kind: "legacy",
    harness: "handoff",
    sessionId: null,
    sessionTitle: "handoff shadow",
    model: null,
    host: null,
    subagentId: null,
    project: null,
    repoRoot: null,
    branch: null,
    commitSha: null,
};

function projectOf(handoff: LegacyHandoff): string {
    return handoff.project ?? handoff.postedByContext.project ?? "unknown";
}

function taskItemId(handoff: string, slot: string): ItemId {
    return asItemId(`${handoff}:${slot}`);
}

class Ingest {
    private readonly handoffId: ItemId;

    constructor(
        private readonly db: Database,
        private readonly handoff: LegacyHandoff
    ) {
        this.handoffId = asItemId(handoff.id);
    }

    private write(change: Omit<NewChange, "v">): void {
        applyChange(this.db, { v: 1, ...change });
    }

    private memberOf(slot: string): Item | null {
        const id = selectMemberBySlot(this.db, this.handoffId, slot);
        return id === null ? null : selectItem(this.db, id);
    }

    ensureHandoffItem(actor: Actor, ts: string, uid: string): void {
        if (selectItem(this.db, this.handoffId) !== null) {
            return;
        }

        const payload: CreatedPayload = {
            type: "handoff",
            state: "open",
            project: projectOf(this.handoff),
            title: this.handoff.title,
            tags: [],
            fields: {},
            ...(this.handoff.description !== undefined ? { body: this.handoff.description } : {}),
        };
        this.write({ ts, item: this.handoffId, actor, kind: "created", payload, origin: { via: "legacy", uid } });
        this.db.run(
            "INSERT INTO handoff_meta (id, name, target) VALUES (?, ?, ?) ON CONFLICT (id) DO UPDATE SET name = excluded.name, target = excluded.target",
            [
                this.handoff.id,
                this.handoff.name ?? null,
                this.handoff.target ? SafeJSON.stringify(this.handoff.target, { strict: true }) : null,
            ]
        );
    }

    /** One task of the old store becomes a member: the existing item it names, or a new item `h_x:tN`. */
    addMember(slot: string, input: LegacyTaskInput, actor: Actor, ts: string, uid: string): void {
        if (selectMemberBySlot(this.db, this.handoffId, slot) !== null) {
            return;
        }

        const origin = { via: "legacy" as const, uid };
        const named = input.item !== undefined ? selectItem(this.db, input.item) : null;
        let itemId: ItemId;

        if (named !== null) {
            itemId = named.id;
        } else {
            itemId = taskItemId(this.handoffId, slot);

            if (selectItem(this.db, itemId) === null) {
                const payload: CreatedPayload = {
                    type: "task",
                    state: "open",
                    project: projectOf(this.handoff),
                    title: input.text,
                    tags: [],
                    fields: {},
                    ...(input.acceptanceCriteria !== undefined ? { acceptance: input.acceptanceCriteria } : {}),
                };
                this.write({ ts, item: itemId, actor, kind: "created", payload, origin });
            }
        }

        this.write({
            ts,
            item: this.handoffId,
            actor,
            kind: "linked",
            payload: { kind: "member", to: itemId, slot },
            origin,
        });
    }

    private moveTo(
        item: Item,
        to: ItemState,
        actor: Actor,
        ts: string,
        uid: string,
        extra: Record<string, unknown> = {}
    ): void {
        if (item.state === to) {
            return;
        }

        this.write({
            ts,
            item: item.id,
            actor,
            kind: "moved",
            payload: { from: item.state, to, ...extra },
            origin: { via: "legacy", uid },
        });
    }

    applyEvent(ref: LegacyEventRef): void {
        const { event, outcome } = ref;

        if (outcome !== null && !outcome.applied) {
            return;
        }

        const actor = legacyActor(event.by);
        const origin = { via: "legacy" as const, uid: event.uid };
        this.ensureHandoffItem(actor, event.ts, event.uid);

        switch (event.ev) {
            case "post":
            case "add_tasks": {
                const inputs = (event.tasks ?? []).filter(
                    (t) => typeof t.text === "string" && t.text.trim().length > 0
                );
                const assigned = outcome?.assignedTaskIds ?? [];

                inputs.forEach((input, index) => {
                    const slot = assigned[index];

                    if (slot !== undefined) {
                        this.addMember(slot, { ...input, text: input.text.trim() }, actor, event.ts, event.uid);
                    }
                });
                break;
            }
            case "claim":
                this.write({ ts: event.ts, item: this.handoffId, actor, kind: "claimed", payload: {}, origin });
                break;
            case "unclaim":
                this.write({ ts: event.ts, item: this.handoffId, actor, kind: "released", payload: {}, origin });
                break;
            case "check_task":
            case "uncheck_task":
            case "deny_task":
            case "undeny_task": {
                const item = event.taskId !== undefined ? this.memberOf(event.taskId) : null;

                if (item === null) {
                    break;
                }

                if (event.ev === "check_task") {
                    for (const commit of event.proof?.commitIds ?? []) {
                        this.write({
                            ts: event.ts,
                            item: item.id,
                            actor,
                            kind: "pointed",
                            payload: { pointer: { kind: "commit", target: commit } },
                            origin,
                        });
                    }

                    this.moveTo(item, "done", actor, event.ts, event.uid, {
                        proof: {
                            text: event.proof?.answer ?? "",
                            ...(event.proof?.commitIds?.length ? { commits: event.proof.commitIds } : {}),
                        },
                    });
                } else if (event.ev === "deny_task") {
                    this.moveTo(item, "dropped", actor, event.ts, event.uid, { why: event.reason ?? "" });
                } else if (item.state === "done" || item.state === "dropped") {
                    this.moveTo(item, "reopened", actor, event.ts, event.uid);
                }

                break;
            }
            case "comment": {
                const text = event.text ?? "";
                const slot = /^\[([A-Za-z0-9_-]+)\] /.exec(text);
                const onTask = slot !== null ? this.memberOf(slot[1]) : null;
                this.write({
                    ts: event.ts,
                    item: onTask?.id ?? this.handoffId,
                    actor,
                    kind: "commented",
                    payload: { text: onTask !== null ? text.slice(slot?.[0].length ?? 0) : text },
                    origin,
                });
                break;
            }
            case "modify_task": {
                const item = event.taskId !== undefined ? this.memberOf(event.taskId) : null;

                if (item === null) {
                    break;
                }

                const set: ItemPatch = {};

                if (event.text !== undefined) {
                    set.title = event.text;
                }

                if (event.acceptanceCriteria !== undefined) {
                    set.acceptance = event.acceptanceCriteria;
                }

                if (Object.keys(set).length > 0) {
                    this.write({ ts: event.ts, item: item.id, actor, kind: "edited", payload: { set }, origin });
                }

                break;
            }
            case "attach": {
                const item = event.taskId !== undefined ? this.memberOf(event.taskId) : null;

                if (event.attachmentId !== undefined) {
                    this.write({
                        ts: event.ts,
                        item: item?.id ?? this.handoffId,
                        actor,
                        kind: "pointed",
                        payload: {
                            pointer: {
                                kind: "attachment",
                                target: event.attachmentId,
                                ...(event.filename !== undefined ? { meta: { filename: event.filename } } : {}),
                            },
                        },
                        origin,
                    });
                }

                break;
            }
            default:
                // finish, cancel, reopen, modify_handoff: the reconcile step below sets state, title, text and project.
                break;
        }
    }

    /** Brings the rows to the folded handoff: the old read model is the truth of these facts in shadow mode. */
    reconcile(uid: string, ts: string): void {
        const handoffItem = selectItem(this.db, this.handoffId);

        if (handoffItem === null) {
            return;
        }

        const origin = { via: "legacy" as const, uid };
        const set: ItemPatch = {};

        if (handoffItem.title !== this.handoff.title) {
            set.title = this.handoff.title;
        }

        if ((handoffItem.body ?? undefined) !== this.handoff.description) {
            set.body = this.handoff.description ?? null;
        }

        if (handoffItem.project !== projectOf(this.handoff)) {
            set.project = projectOf(this.handoff);
        }

        if (Object.keys(set).length > 0) {
            this.write({
                ts,
                item: this.handoffId,
                actor: RECONCILER,
                kind: "edited",
                payload: { set, reconcile: true },
                origin,
            });
        }

        const wanted = handoffStateOf(this.handoff.status);

        if (handoffItem.state !== wanted) {
            this.moveTo(handoffItem, wanted, RECONCILER, ts, uid, { reconcile: true });
        }

        for (const task of this.handoff.tasks) {
            if (selectMemberBySlot(this.db, this.handoffId, task.id) === null) {
                this.addMember(
                    task.id,
                    { text: task.text, acceptanceCriteria: task.acceptanceCriteria },
                    RECONCILER,
                    ts,
                    uid
                );
            }

            const item = this.memberOf(task.id);

            if (item === null) {
                continue;
            }

            const patch: ItemPatch = {};

            if (item.title !== task.text) {
                patch.title = task.text;
            }

            if ((item.acceptance ?? undefined) !== task.acceptanceCriteria) {
                patch.acceptance = task.acceptanceCriteria ?? null;
            }

            if (Object.keys(patch).length > 0) {
                this.write({
                    ts,
                    item: item.id,
                    actor: RECONCILER,
                    kind: "edited",
                    payload: { set: patch, reconcile: true },
                    origin,
                });
            }

            const state = taskStateOf(task);

            if (state !== null) {
                this.moveTo(item, state, RECONCILER, ts, uid, { reconcile: true });
            } else if (!OPEN_STATES.has(item.state)) {
                this.moveTo(item, item.state === "spotted" ? "open" : "reopened", RECONCILER, ts, uid, {
                    reconcile: true,
                });
            }
        }
    }
}

function seen(db: Database, uid: string): boolean {
    return db.query("SELECT 1 FROM legacy_cursor WHERE uid = ?").get(uid) !== null;
}

/**
 * Brings one handoff of the old store into the work store. Safe to repeat: each event is applied once (by its uid),
 * and the reconcile step only writes when a row differs from the folded handoff.
 */
export function ingestLegacyHandoff(db: Database, handoff: LegacyHandoff, events: Iterable<LegacyEventRef>): void {
    const own = !db.inTransaction;

    if (own) {
        db.run("BEGIN IMMEDIATE");
    }

    try {
        const ingest = new Ingest(db, handoff);
        let lastUid = `snapshot:${handoff.id}`;
        let lastTs = handoff.createdTs;

        for (const ref of events) {
            if (ref.event.id !== handoff.id || seen(db, ref.event.uid)) {
                continue;
            }

            ingest.applyEvent(ref);
            db.run("INSERT INTO legacy_cursor (uid, handoff, ts) VALUES (?, ?, ?)", [
                ref.event.uid,
                handoff.id,
                ref.event.ts,
            ]);
            lastUid = ref.event.uid;
            lastTs = ref.event.ts;
        }

        ingest.ensureHandoffItem(legacyActor(handoff.postedByContext), handoff.createdTs, lastUid);
        ingest.reconcile(lastUid, lastTs);

        if (own) {
            db.run("COMMIT");
        }
    } catch (error) {
        if (own) {
            db.run("ROLLBACK");
        }

        throw error;
    }
}

/** One difference between the work store and the old read model. A pure read. */
export interface ParityDifference {
    handoff: string;
    slot?: string;
    what: string;
}

export function parityOf(db: Database, handoff: LegacyHandoff): ParityDifference[] {
    const out: ParityDifference[] = [];
    const item = selectItem(db, handoff.id);

    if (item === null) {
        return [{ handoff: handoff.id, what: "no item in the work store (the backfill has not seen it)" }];
    }

    if (item.state !== handoffStateOf(handoff.status)) {
        out.push({ handoff: handoff.id, what: `state ${item.state}, old status ${handoff.status}` });
    }

    if (item.title !== handoff.title) {
        out.push({ handoff: handoff.id, what: "title differs" });
    }

    const memberCount = (
        db.query("SELECT COUNT(*) AS n FROM refs WHERE kind = 'member' AND from_id = ?").get(handoff.id) as {
            n: number;
        }
    ).n;

    if (memberCount !== handoff.tasks.length) {
        out.push({ handoff: handoff.id, what: `${memberCount} members, old store has ${handoff.tasks.length} tasks` });
    }

    for (const task of handoff.tasks) {
        const id = selectMemberBySlot(db, handoff.id, task.id);
        const member = id === null ? null : selectItem(db, id);

        if (member === null) {
            out.push({ handoff: handoff.id, slot: task.id, what: "missing member" });
            continue;
        }

        const wanted = taskStateOf(task);

        if (wanted !== null ? member.state !== wanted : !OPEN_STATES.has(member.state)) {
            out.push({
                handoff: handoff.id,
                slot: task.id,
                what: `state ${member.state}, old task ${task.checked ? "checked" : task.denied ? "denied" : "open"}`,
            });
        }

        if (member.title !== task.text) {
            out.push({ handoff: handoff.id, slot: task.id, what: "text differs" });
        }
    }

    return out;
}
