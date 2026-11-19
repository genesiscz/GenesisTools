/**
 * The numbered to-do items of agent sessions (`question_post` with `type: "todo"`) as items of the work store: one
 * item of type `task` with the tag `session-todo` per row, keyed by the pointer `session-todo:<session>#<number>`, so a
 * reply's "TODO 3" and the store agree (P9 decision 1). The mirror is idempotent: a row that did not change writes
 * nothing, and a run over the whole log is also the one-time import (decision 2).
 */
import type { Database } from "bun:sqlite";
import { SafeJSON } from "@genesiscz/utils/json";
import type { Actor, ItemId } from "../model/item";
import { asItemId } from "../model/item";
import type { ItemPatch } from "../model/payloads";
import type { ItemState } from "../model/vocab";
import { randomItemSuffix } from "../service";
import { applyChange } from "../store/apply";
import { selectItem } from "../store/rows";

export const SESSION_TODO_POINTER = "session-todo";
export const SESSION_TODO_TAG = "session-todo";

/**
 * The fields of a decision-log row the mirror reads; the question tool's `DecisionRecord` has them all. The other
 * fields of the row ride along in the pointer, so the row comes back whole (`readSessionTodos`).
 */
export interface SessionTodoRow {
    id: string;
    sessionId: string;
    number: number;
    prompt: string;
    title?: string;
    state: string;
    for?: string;
    blocking?: boolean;
    provider?: string;
    sessionTitle?: string;
    project?: string;
    cwd?: string;
    repoRoot?: string;
    branch?: string | null;
    commitSha?: string | null;
    aiAgent?: string | null;
    isWorktree?: boolean;
    worktreePath?: string | null;
    createdTs?: string;
    updatedTs: string;
    revision?: number;
}

/** What the pointer keeps: the row without its text and state (the item has those), and the log's own state word. */
export type SessionTodoMeta = Omit<SessionTodoRow, "prompt" | "state"> & { logState: string } & Record<string, unknown>;

/** A row as the store gives it back: the known fields and every other field the log row had. */
export type StoredSessionTodo = SessionTodoRow & Record<string, unknown>;

function isSessionTodoMeta(value: unknown): value is SessionTodoMeta {
    if (value === null || typeof value !== "object") {
        return false;
    }

    const v = value as Record<string, unknown>;
    return (
        typeof v.id === "string" &&
        typeof v.sessionId === "string" &&
        typeof v.number === "number" &&
        typeof v.updatedTs === "string" &&
        typeof v.logState === "string"
    );
}

/** The states of the log mapped to item states (list 2 of the detail file). */
const STATE_OF: Record<string, ItemState> = {
    open: "open",
    acknowledged: "active",
    implemented: "done",
    dismissed: "dropped",
    superseded: "dropped",
};

export function sessionTodoState(state: string): ItemState {
    return STATE_OF[state] ?? "open";
}

/** The state of the log an item state stands for; the inverse of {@link sessionTodoState} on the four to-do states. */
export function sessionTodoLogState(state: ItemState): string {
    return state === "active"
        ? "acknowledged"
        : state === "done"
          ? "implemented"
          : state === "dropped"
            ? "dismissed"
            : "open";
}

/** The to-do rows as the store holds them: the pointer's fields, the item's text and state, newest change first. */
export function readSessionTodos(db: Database, sessionId?: string): { rows: StoredSessionTodo[]; stamp: string } {
    const stamp = String((db.query("SELECT MAX(seq) AS seq FROM changes").get() as { seq: number | null }).seq ?? 0);
    const rows = db
        .query<
            {
                meta: string | null;
                title: string;
                body: string | null;
                state: ItemState;
                owner: string | null;
                updatedTs: string;
            },
            [string, ...string[]]
        >(
            `SELECT p.meta, i.title, i.body, i.state, i.for_who AS owner, i.updated_ts AS updatedTs
             FROM pointers p JOIN items i ON i.id = p.item
             WHERE p.kind = ?${sessionId === undefined ? "" : " AND json_extract(p.meta, '$.sessionId') = ?"}
             ORDER BY i.updated_ts DESC, i.id`
        )
        .all(SESSION_TODO_POINTER, ...(sessionId === undefined ? [] : [sessionId]))
        .flatMap((r) => {
            const meta: unknown = r.meta === null ? null : SafeJSON.parse(r.meta);

            if (!isSessionTodoMeta(meta)) {
                return [];
            }

            const { logState, ...rest } = meta;
            // The log's word survives while the item still stands for it (superseded and dismissed are both dropped);
            // a move through the store (`tools work finish`) gives the word of the new state.
            const state = sessionTodoState(logState) === r.state ? logState : sessionTodoLogState(r.state);
            return [
                {
                    ...rest,
                    ...(rest.title !== undefined ||
                    r.title !== mirrorTitle({ prompt: r.body ?? "", number: rest.number })
                        ? { title: r.title }
                        : {}),
                    for: r.owner ?? rest.for ?? "agent",
                    updatedTs: r.updatedTs > rest.updatedTs ? r.updatedTs : rest.updatedTs,
                    prompt: r.body ?? "",
                    state,
                },
            ];
        });
    return { rows, stamp };
}

export function sessionTodoKey(row: Pick<SessionTodoRow, "sessionId" | "number">): string {
    return `${row.sessionId}#${row.number}`;
}

function projectOf(row: SessionTodoRow): string {
    const path = row.repoRoot ?? row.cwd;
    return row.project ?? (path ? (path.split(/[/\\]/).filter(Boolean).pop() ?? "unknown") : "unknown");
}

function actorOf(row: SessionTodoRow): Actor {
    return {
        kind: "agent",
        harness: row.provider ?? "unknown",
        sessionId: row.sessionId,
        sessionTitle: row.sessionTitle ?? null,
        model: null,
        host: null,
        subagentId: null,
        project: projectOf(row),
        repoRoot: row.repoRoot ?? null,
        branch: row.branch ?? null,
        commitSha: row.commitSha ?? null,
    };
}

function mirrorTitle(row: Pick<SessionTodoRow, "title" | "prompt" | "number">): string {
    return (row.title || row.prompt.split("\n")[0] || `TODO ${row.number}`).slice(0, 500);
}

function metaOf(row: SessionTodoRow): SessionTodoMeta {
    const { prompt: _prompt, state, ...rest } = row;
    return { ...rest, logState: state };
}

export interface MirrorReport {
    created: number;
    changed: number;
    unchanged: number;
}

/** Brings the store up to the given rows; the caller holds no transaction (each row is one). */
export function mirrorSessionTodos(
    db: Database,
    rows: readonly SessionTodoRow[],
    random: () => string = randomItemSuffix
): MirrorReport {
    const report: MirrorReport = { created: 0, changed: 0, unchanged: 0 };
    const lookup = db.query<{ item: ItemId; meta: string | null }, [string, string]>(
        "SELECT item, meta FROM pointers WHERE kind = ? AND target = ?"
    );

    for (const row of rows) {
        const key = sessionTodoKey(row);
        const title = mirrorTitle(row);
        const state = sessionTodoState(row.state);
        const meta = metaOf(row);
        const metaJson = SafeJSON.stringify(meta);

        const ts = row.updatedTs;
        const actor = actorOf(row);
        const origin = { via: "legacy" as const, uid: `${SESSION_TODO_POINTER}:${row.id}:${row.updatedTs}` };

        const result = db
            .transaction((): keyof MirrorReport => {
                const had = lookup.get(SESSION_TODO_POINTER, key);
                const id = had?.item ?? asItemId(`w_${random()}`);
                const item = had === null ? null : selectItem(db, id);
                const base = { v: 1 as const, ts, item: id, actor, origin };
                let wrote = false;

                if (item !== null && item.updatedTs > ts) {
                    return "unchanged";
                }

                if (item === null) {
                    applyChange(db, {
                        ...base,
                        kind: "created",
                        payload: {
                            type: "task",
                            state,
                            project: projectOf(row),
                            title,
                            body: row.prompt,
                            ...(row.for !== undefined ? { for: row.for } : {}),
                            tags: [SESSION_TODO_TAG],
                            fields: {},
                        },
                    });
                    wrote = true;
                } else {
                    const set: ItemPatch = {};

                    if (row.for !== undefined && item.for !== row.for) {
                        set.for = row.for;
                    }

                    if (item.title !== title) {
                        set.title = title;
                    }

                    if ((item.body ?? "") !== row.prompt) {
                        set.body = row.prompt;
                    }

                    const project = projectOf(row);
                    if (item.project !== project) {
                        set.project = project;
                    }

                    if (Object.keys(set).length > 0) {
                        applyChange(db, { ...base, kind: "edited", payload: { set, reconcile: true } });
                        wrote = true;
                    }

                    if (item.state !== state) {
                        applyChange(db, {
                            ...base,
                            kind: "moved",
                            payload: { from: item.state, to: state, reconcile: true },
                        });
                        wrote = true;
                    }
                }

                if (had?.meta !== metaJson) {
                    applyChange(db, {
                        ...base,
                        kind: "pointed",
                        payload: { pointer: { kind: SESSION_TODO_POINTER, target: key, meta: { ...meta } } },
                    });
                }

                return item === null ? "created" : wrote || had?.meta !== metaJson ? "changed" : "unchanged";
            })
            .immediate();

        report[result]++;
    }

    return report;
}
