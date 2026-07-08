import type { DatabaseClient } from "@app/utils/database/client";
import { escapeLike } from "@app/utils/database/predicates";
import { env } from "@app/utils/env";
import { SafeJSON } from "@app/utils/json";
import { type Selectable, type SqlBool, sql, type Transaction } from "kysely";
import { getAnnotation } from "./annotations-store";
import { toCardDto } from "./boards-store";
import type { BoardsDb, ListenersTable } from "./db-types";
import { publishBoardEvent, wakeWorkWaiters } from "./events";
import { NotFoundError, slugifyBranch } from "./sets-store";
import { nowIso } from "./time";
import type {
    AnnotationDto,
    AnnotationStatus,
    CardDto,
    ChoiceItemDto,
    ListenerDto,
    WorkItemDto,
    WorkScope,
} from "./types";

export const DEFAULT_LISTENER_TTL_MS = 90_000;

export function listenerTtlMs(): number {
    return env.boards.getListenerTtlMs() ?? DEFAULT_LISTENER_TTL_MS;
}

export interface LeaseConflict {
    conflict: true;
    holder: ListenerDto;
    /** Whether the holder's lease is still within TTL. An expired holder is reported (not
     *  silently stolen) unless the claim carried `takeover`. */
    live: boolean;
}
export interface LeaseOk {
    conflict: false;
    id: number;
}

function toListenerDto(row: {
    id: number;
    scope_kind: string;
    scope: string;
    branch: string;
    actor: string;
    session: string;
    created_at: string;
    last_seen: string;
}): ListenerDto {
    return {
        id: row.id,
        scopeKind: row.scope_kind,
        scope: row.scope,
        branch: row.branch,
        actor: row.actor,
        session: row.session,
        createdAt: row.created_at,
        lastSeen: row.last_seen,
    };
}

function scopeColumns(scope: WorkScope): { scope_kind: string; scope: string; branch: string } {
    if (scope.kind === "all") {
        return { scope_kind: "all", scope: "", branch: "" };
    }
    if (scope.kind === "board") {
        return { scope_kind: "board", scope: scope.board, branch: "" };
    }
    return { scope_kind: "project", scope: scope.project, branch: scope.branch };
}

/** default status "open"; FIFO by created_at. project/branch matches the annotated card's
 *  set_ref prefix ("project/" or, with branch, "project/branch-slug/"). */
export async function listWork(
    db: DatabaseClient<BoardsDb>,
    filter: { status?: string; board?: string; project?: string; branch?: string }
): Promise<WorkItemDto[]> {
    const status = filter.status ?? "open";
    let q = db.kysely
        .selectFrom("annotations")
        .innerJoin("boards", "boards.id", "annotations.board_id")
        .innerJoin("board_cards", "board_cards.id", "annotations.card_id")
        .select([
            "annotations.id as id",
            "boards.slug as board",
            "boards.title as boardTitle",
            "annotations.card_id as cardId",
            "annotations.intent as intent",
            "annotations.intent_other as intentOther",
            "annotations.status as status",
            "board_cards.set_ref as setRef",
            "board_cards.file_path as file",
            "annotations.created_at as createdAt",
            "annotations.updated_at as updatedAt",
        ])
        .where("annotations.status", "=", status);

    if (filter.board) {
        q = q.where("boards.slug", "=", filter.board);
    }
    if (filter.project) {
        const prefix = filter.branch ? `${filter.project}/${slugifyBranch(filter.branch)}/` : `${filter.project}/`;
        const pattern = `${escapeLike(prefix)}%`;
        q = q.where(sql<SqlBool>`board_cards.set_ref LIKE ${pattern} ESCAPE '\\'`);
    }

    const rows = await q.orderBy("annotations.created_at", "asc").execute();
    const ids = rows.map((r) => r.id);
    const promptByAnnotation = new Map<number, string>();
    if (ids.length > 0) {
        const revisionRows = await db.kysely
            .selectFrom("annotation_revisions")
            .select(["annotation_id", "prompt"])
            .where("annotation_id", "in", ids)
            .orderBy("id", "asc")
            .execute();
        for (const r of revisionRows) {
            promptByAnnotation.set(r.annotation_id, r.prompt); // last write (highest id) wins
        }
    }

    return rows.map((r) => ({
        id: r.id,
        board: r.board,
        boardTitle: r.boardTitle,
        cardId: r.cardId,
        intent: r.intent,
        intentOther: r.intentOther || undefined,
        status: r.status as AnnotationStatus,
        prompt: promptByAnnotation.get(r.id) ?? "",
        setRef: r.setRef,
        file: r.file,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
    }));
}

function scopeToListWorkFilter(scope: WorkScope): { board?: string; project?: string; branch?: string } {
    if (scope.kind === "board") {
        return { board: scope.board };
    }
    if (scope.kind === "project") {
        return { project: scope.project, branch: scope.branch };
    }
    return {};
}

export interface OpenWorkItem {
    annotation: AnnotationDto;
    card: CardDto;
    boardSlug: string;
}

/** Same scoping as listWork, but resolved to full AnnotationDto + CardDto (for capsule building). */
export async function listOpenWorkDetailed(db: DatabaseClient<BoardsDb>, scope: WorkScope): Promise<OpenWorkItem[]> {
    const items = await listWork(db, { status: "open", ...scopeToListWorkFilter(scope) });
    const result: OpenWorkItem[] = [];
    for (const item of items) {
        const annotation = await getAnnotation(db, item.id);
        const cardRow = await db.kysely
            .selectFrom("board_cards")
            .selectAll()
            .where("id", "=", annotation.cardId)
            .executeTakeFirst();
        if (!cardRow) {
            continue; // a card is required to create an annotation; this shouldn't happen
        }
        result.push({ annotation, card: toCardDto(cardRow), boardSlug: annotation.boardSlug });
    }
    return result;
}

/** Reverts a listener's claimed ("working") annotations back to "open". Returns the reverted
 *  {id, boardSlug} pairs so callers can publish `status` events AFTER their transaction commits
 *  (mirrors dispatchBoard's publish-after-commit pattern). Caller deletes the listener row. */
async function revertClaimsForListener(
    trx: Transaction<BoardsDb>,
    listenerId: number
): Promise<Array<{ id: number; boardSlug: string }>> {
    const claimed = await trx
        .selectFrom("annotations")
        .innerJoin("boards", "boards.id", "annotations.board_id")
        .select(["annotations.id as id", "boards.slug as boardSlug"])
        .where("annotations.claimed_listener", "=", listenerId)
        .where("annotations.status", "=", "working")
        .execute();

    const now = nowIso();
    for (const c of claimed) {
        await trx
            .updateTable("annotations")
            .set({ status: "open", claimed_by: "", claimed_listener: 0, claimed_at: "", updated_at: now })
            .where("id", "=", c.id)
            .execute();
    }

    return claimed;
}

/** Deletes leases with last_seen older than the TTL, reverting their claimed items. The expired
 *  SELECT and the DELETE both run inside the same transaction, and the DELETE re-checks
 *  `last_seen < cutoff`, so a listener that renewed between the SELECT and commit survives
 *  (no TOCTOU reap of a listener that's actually still alive). */
export async function reapExpiredListeners(db: DatabaseClient<BoardsDb>): Promise<number[]> {
    const cutoff = new Date(Date.now() - listenerTtlMs()).toISOString();

    const reverted = await db.kysely.transaction().execute(async (trx) => {
        const expired = await trx.selectFrom("listeners").select("id").where("last_seen", "<", cutoff).execute();
        if (expired.length === 0) {
            return [];
        }
        const expiredIds = expired.map((l) => l.id);

        const items: Array<{ id: number; boardSlug: string }> = [];
        for (const listenerId of expiredIds) {
            items.push(...(await revertClaimsForListener(trx, listenerId)));
        }
        await trx.deleteFrom("listeners").where("id", "in", expiredIds).where("last_seen", "<", cutoff).execute();
        return items;
    });

    for (const item of reverted) {
        publishBoardEvent(item.boardSlug, { type: "status", payload: { id: item.id, status: "open" } });
    }
    if (reverted.length > 0) {
        wakeWorkWaiters();
    }
    return reverted.map((item) => item.id);
}

/** One live lease per exact (scope_kind, scope, branch) for "board"/"project" scopes — the
 *  singleton holder either renews (same session) or conflicts (a different live session).
 *  "all" scope is per-session instead: it never conflicts, and every session gets (and keeps
 *  renewing) its own row, so all concurrent "all" listeners stay visible in listListeners. */
export async function claimOrRenewLease(
    db: DatabaseClient<BoardsDb>,
    scope: WorkScope,
    session: string,
    actor: string,
    takeover = false
): Promise<LeaseOk | LeaseConflict> {
    const cols = scopeColumns(scope);
    const now = nowIso();

    if (cols.scope_kind === "all") {
        const existing = await db.kysely
            .selectFrom("listeners")
            .selectAll()
            .where("scope_kind", "=", "all")
            .where("session", "=", session)
            .executeTakeFirst();
        if (existing) {
            await db.kysely
                .updateTable("listeners")
                .set({ last_seen: now, actor })
                .where("id", "=", existing.id)
                .execute();
            return { conflict: false, id: existing.id };
        }
        const inserted = await db.kysely
            .insertInto("listeners")
            .values({ scope_kind: "all", scope: "", branch: "", actor, session, created_at: now, last_seen: now })
            .returningAll()
            .executeTakeFirstOrThrow();
        return { conflict: false, id: inserted.id };
    }

    const holder = await db.kysely
        .selectFrom("listeners")
        .selectAll()
        .where("scope_kind", "=", cols.scope_kind)
        .where("scope", "=", cols.scope)
        .where("branch", "=", cols.branch)
        .executeTakeFirst();

    if (holder) {
        if (holder.session === session) {
            await db.kysely
                .updateTable("listeners")
                .set({ last_seen: now, actor })
                .where("id", "=", holder.id)
                .execute();
            return { conflict: false, id: holder.id };
        }
        // Steal expired leases ONLY, and only when the caller asked (takeover) — a live holder is
        // never displaced (parity with listeners.stealExpired, listeners.go:155-178). reapExpired
        // usually clears expired rows first; this covers the window where it hasn't run or TTLs differ.
        const cutoff = new Date(Date.now() - listenerTtlMs()).toISOString();
        const live = holder.last_seen >= cutoff;
        if (!(takeover && !live)) {
            return { conflict: true, holder: toListenerDto(holder), live };
        }
        await releaseLease(db, holder.id); // revert its claimed items + delete, then claim fresh below
    }

    // Upsert against idx_listeners_scope (db.ts BOOTSTRAP_DDL): if another racer inserted the
    // row between our SELECT above and this INSERT, we take over the lease (session/actor/
    // last_seen overwritten to us) rather than throwing a raw UNIQUE-constraint error. The
    // racer we displaced discovers the loss on its own next SELECT. Kysely's onConflict
    // builder can't target a partial unique index's WHERE clause, so this is raw SQL.
    const upsertResult = await sql<Selectable<ListenersTable>>`
        INSERT INTO listeners (scope_kind, scope, branch, actor, session, created_at, last_seen)
        VALUES (${cols.scope_kind}, ${cols.scope}, ${cols.branch}, ${actor}, ${session}, ${now}, ${now})
        ON CONFLICT (scope_kind, scope, branch) WHERE scope_kind != 'all'
        DO UPDATE SET session = excluded.session, actor = excluded.actor, last_seen = excluded.last_seen
        RETURNING *
    `.execute(db.kysely);
    const upserted = upsertResult.rows[0];
    return { conflict: false, id: upserted.id };
}

export async function releaseLease(db: DatabaseClient<BoardsDb>, id: number): Promise<number[]> {
    const reverted = await db.kysely.transaction().execute(async (trx) => {
        const items = await revertClaimsForListener(trx, id);
        await trx.deleteFrom("listeners").where("id", "=", id).execute();
        return items;
    });
    for (const item of reverted) {
        publishBoardEvent(item.boardSlug, { type: "status", payload: { id: item.id, status: "open" } });
    }
    if (reverted.length > 0) {
        wakeWorkWaiters();
    }
    return reverted.map((item) => item.id);
}

export async function listListeners(db: DatabaseClient<BoardsDb>): Promise<ListenerDto[]> {
    const cutoff = new Date(Date.now() - listenerTtlMs()).toISOString();
    const rows = await db.kysely
        .selectFrom("listeners")
        .selectAll()
        .where("last_seen", ">=", cutoff)
        .orderBy("id", "asc")
        .execute();
    return rows.map(toListenerDto);
}

/** ONE tx: staged annotations -> open; staged ANSWERED questions -> staged=0 (unanswered staged
 *  questions stay held). Then per-item `status`/`question` SSE, ONE wakeWorkWaiters(). */
export async function dispatchBoard(
    db: DatabaseClient<BoardsDb>,
    boardSlug: string
): Promise<{ opened: number[]; releasedQuestions: number[] }> {
    const board = await db.kysely.selectFrom("boards").select("id").where("slug", "=", boardSlug).executeTakeFirst();
    if (!board) {
        throw new NotFoundError(`board not found: ${boardSlug}`);
    }
    const now = nowIso();

    const { opened, releasedQuestions } = await db.kysely.transaction().execute(async (trx) => {
        const stagedAnnotations = await trx
            .selectFrom("annotations")
            .select("id")
            .where("board_id", "=", board.id)
            .where("status", "=", "staged")
            .execute();
        for (const a of stagedAnnotations) {
            await trx
                .updateTable("annotations")
                .set({ status: "open", updated_at: now })
                .where("id", "=", a.id)
                .execute();
        }

        const stagedAnsweredQuestions = await trx
            .selectFrom("board_questions")
            .select("id")
            .where("board_id", "=", board.id)
            .where("staged", "=", 1)
            .where("answer", "!=", "")
            .execute();
        for (const question of stagedAnsweredQuestions) {
            await trx.updateTable("board_questions").set({ staged: 0 }).where("id", "=", question.id).execute();
        }

        return {
            opened: stagedAnnotations.map((a) => a.id),
            releasedQuestions: stagedAnsweredQuestions.map((question) => question.id),
        };
    });

    for (const id of opened) {
        publishBoardEvent(boardSlug, { type: "status", payload: { id, status: "open" } });
    }
    for (const id of releasedQuestions) {
        publishBoardEvent(boardSlug, { type: "question", payload: { id } });
    }
    if (opened.length > 0 || releasedQuestions.length > 0) {
        wakeWorkWaiters();
    }

    return { opened, releasedQuestions };
}

/** Answered, non-staged, undelivered questions in scope -> delivered=1 (same tx), returned once. */
export async function drainChoices(db: DatabaseClient<BoardsDb>, scope: WorkScope): Promise<ChoiceItemDto[]> {
    return db.kysely.transaction().execute(async (trx) => {
        const rows = await selectDrainableQuestions(trx, scope);
        if (rows.length === 0) {
            return [];
        }
        const ids = rows.map((r) => r.id);
        await trx.updateTable("board_questions").set({ delivered: 1 }).where("id", "in", ids).execute();

        return rows.map((r) => ({
            type: "choice" as const,
            id: r.id,
            board: r.board,
            cardId: r.cardId === 0 ? null : r.cardId,
            question: r.prompt,
            option: r.answer ? (SafeJSON.parse(r.answer, { strict: true }) as string[]) : [],
            multi: r.multi === 1,
            actor: r.answeredBy,
        }));
    });
}

async function selectDrainableQuestions(
    trx: Transaction<BoardsDb>,
    scope: WorkScope
): Promise<
    Array<{
        id: number;
        board: string;
        cardId: number;
        prompt: string;
        answer: string;
        multi: number;
        answeredBy: string;
    }>
> {
    let q = trx
        .selectFrom("board_questions")
        .innerJoin("boards", "boards.id", "board_questions.board_id")
        .select([
            "board_questions.id as id",
            "boards.slug as board",
            "board_questions.card_id as cardId",
            "board_questions.prompt as prompt",
            "board_questions.answer as answer",
            "board_questions.multi as multi",
            "board_questions.answered_by as answeredBy",
        ])
        .where("board_questions.staged", "=", 0)
        .where("board_questions.delivered", "=", 0)
        .where("board_questions.answer", "!=", "");

    if (scope.kind === "board") {
        q = q.where("boards.slug", "=", scope.board);
    } else if (scope.kind === "project") {
        // Questions aren't set_ref-scoped like annotations (a board isn't branch-scoped), so
        // project scope matches the board's project only; branch has no meaning here.
        q = q.where("boards.project", "=", scope.project);
    }

    return q.execute();
}
