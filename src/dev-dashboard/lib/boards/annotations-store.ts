import type { DatabaseClient } from "@app/utils/database/client";
import { SafeJSON } from "@app/utils/json";
import type { Kysely, Selectable } from "kysely";
import type { BoardCardsTable, BoardsDb } from "./db-types";
import { NotFoundError } from "./sets-store";
import { nowIso } from "./time";
import type { AnnotationDto, AnnotationStatus, AttemptDto, CardDto, MessageDto, Region, RevisionDto } from "./types";

export const PATCHABLE_STATUSES: ReadonlySet<string> = new Set(["staged", "open", "working", "in_review", "resolved"]);
export const CANCELLABLE_FROM: ReadonlySet<string> = new Set(["staged", "open", "working"]);

export class CancelledError extends Error {} // route → 409 { code: "cancelled" }
export class NotCancellableError extends Error {} // route → 409 { code: "not_cancellable" }
export class NotUndoableError extends Error {} // route → 409 { code: "not_undoable" }
export class InvalidStatusError extends Error {} // route → 400

// Private duplicate of boards-store.ts's toCardDto — kept local to avoid a boards-store <->
// annotations-store import cycle (boards-store's getBoardDoc calls getBoardAnnotations below).
// Keep in sync with boards-store.ts's toCardDto if board_cards columns change.
function toCardDto(row: Selectable<BoardCardsTable>): CardDto {
    return {
        id: row.id,
        boardId: row.board_id,
        kind: row.kind,
        x: row.x,
        y: row.y,
        w: row.w,
        h: row.h,
        z: row.z,
        setRef: row.set_ref,
        setVersion: row.set_version,
        filePath: row.file_path,
        blobKey: row.blob_key,
        payload: SafeJSON.parse(row.payload || "{}", { strict: true }) as Record<string, unknown>,
        createdBy: row.created_by,
        elemNo: row.elem_no,
        currentVersion: row.current_version,
    };
}

// Private duplicate of boards-store.ts's nextCardVersionNumber — same import-cycle reason as
// toCardDto above. MUST stay MAX(version)+1, never board_cards.current_version+1 (see
// boards-store.ts's nextCardVersionNumber doc comment for why).
async function nextCardVersionNumber(kysely: Kysely<BoardsDb>, cardId: number): Promise<number> {
    const row = await kysely
        .selectFrom("card_versions")
        .select(({ fn }) => fn.max("version").as("maxVersion"))
        .where("card_id", "=", cardId)
        .executeTakeFirst();
    return Number(row?.maxVersion ?? 0) + 1;
}

function toMessageDto(row: {
    id: number;
    annotation_id: number;
    board_id: number;
    author: string;
    body: string;
    created_at: string;
}): MessageDto {
    return {
        id: row.id,
        annotationId: row.annotation_id === 0 ? null : row.annotation_id,
        boardId: row.board_id === 0 ? null : row.board_id,
        author: row.author,
        body: row.body,
        createdAt: row.created_at,
    };
}

function toRevisionDto(row: { id: number; prompt: string; created_by: string; created_at: string }): RevisionDto {
    return { id: row.id, prompt: row.prompt, createdBy: row.created_by, createdAt: row.created_at };
}

function toAttemptDto(row: {
    id: number;
    annotation_id: number;
    revision_id: number;
    after_set_ref: string;
    after_version: number;
    after_file: string;
    after_blob_key: string;
    agent: string;
    commit_ref: string;
    verdict: string;
    created_at: string;
}): AttemptDto {
    return {
        id: row.id,
        annotationId: row.annotation_id,
        revisionId: row.revision_id,
        afterSetRef: row.after_set_ref,
        afterVersion: row.after_version,
        afterFile: row.after_file,
        afterBlobKey: row.after_blob_key,
        agent: row.agent,
        commitRef: row.commit_ref,
        verdict: row.verdict as AttemptDto["verdict"],
        createdAt: row.created_at,
    };
}

function toAnnotationDto(
    row: {
        id: number;
        board_id: number;
        card_id: number;
        region: string;
        intent: string;
        intent_other: string;
        status: string;
        assignee: string;
        created_by: string;
        card_version: number;
        created_at: string;
        updated_at: string;
    },
    boardSlug: string,
    revisions: RevisionDto[],
    messages: MessageDto[],
    attempts: AttemptDto[]
): AnnotationDto {
    return {
        id: row.id,
        boardId: row.board_id,
        boardSlug,
        cardId: row.card_id,
        region: SafeJSON.parse(row.region, { strict: true }) as Region,
        intent: row.intent,
        intentOther: row.intent_other,
        status: row.status as AnnotationStatus,
        assignee: row.assignee,
        createdBy: row.created_by,
        cardVersion: row.card_version,
        prompt: revisions.length > 0 ? revisions[revisions.length - 1].prompt : "",
        revisions,
        messages,
        attempts,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

async function loadAnnotationDto(kysely: Kysely<BoardsDb>, id: number): Promise<AnnotationDto> {
    const row = await kysely.selectFrom("annotations").selectAll().where("id", "=", id).executeTakeFirst();
    if (!row) {
        throw new NotFoundError(`annotation not found: ${id}`);
    }
    const board = await kysely.selectFrom("boards").select("slug").where("id", "=", row.board_id).executeTakeFirst();

    const revisionRows = await kysely
        .selectFrom("annotation_revisions")
        .selectAll()
        .where("annotation_id", "=", id)
        .orderBy("id", "asc")
        .execute();
    const messageRows = await kysely
        .selectFrom("annotation_messages")
        .selectAll()
        .where("annotation_id", "=", id)
        .orderBy("id", "asc")
        .execute();
    const attemptRows = await kysely
        .selectFrom("annotation_attempts")
        .selectAll()
        .where("annotation_id", "=", id)
        .orderBy("id", "asc")
        .execute();

    return toAnnotationDto(
        row,
        board?.slug ?? "",
        revisionRows.map(toRevisionDto),
        messageRows.map(toMessageDto),
        attemptRows.map(toAttemptDto)
    );
}

/** Bulk-loads every annotation on a board with its revisions/messages/attempts, one query per
 *  table (not N+1 per annotation). Consumed by boards-store.ts's getBoardDoc. */
export async function getBoardAnnotations(
    db: DatabaseClient<BoardsDb>,
    boardId: number,
    boardSlug: string
): Promise<AnnotationDto[]> {
    const kysely = db.kysely;
    const annotationRows = await kysely
        .selectFrom("annotations")
        .selectAll()
        .where("board_id", "=", boardId)
        .orderBy("id", "asc")
        .execute();
    if (annotationRows.length === 0) {
        return [];
    }

    const ids = annotationRows.map((r) => r.id);
    const revisionRows = await kysely
        .selectFrom("annotation_revisions")
        .selectAll()
        .where("annotation_id", "in", ids)
        .orderBy("id", "asc")
        .execute();
    const messageRows = await kysely
        .selectFrom("annotation_messages")
        .selectAll()
        .where("annotation_id", "in", ids)
        .orderBy("id", "asc")
        .execute();
    const attemptRows = await kysely
        .selectFrom("annotation_attempts")
        .selectAll()
        .where("annotation_id", "in", ids)
        .orderBy("id", "asc")
        .execute();

    const revisionsByAnnotation = groupBy(revisionRows, (r) => r.annotation_id);
    const messagesByAnnotation = groupBy(messageRows, (r) => r.annotation_id);
    const attemptsByAnnotation = groupBy(attemptRows, (r) => r.annotation_id);

    return annotationRows.map((row) =>
        toAnnotationDto(
            row,
            boardSlug,
            (revisionsByAnnotation.get(row.id) ?? []).map(toRevisionDto),
            (messagesByAnnotation.get(row.id) ?? []).map(toMessageDto),
            (attemptsByAnnotation.get(row.id) ?? []).map(toAttemptDto)
        )
    );
}

function groupBy<T, K>(rows: T[], key: (row: T) => K): Map<K, T[]> {
    const map = new Map<K, T[]>();
    for (const row of rows) {
        const k = key(row);
        const list = map.get(k);
        if (list) {
            list.push(row);
        } else {
            map.set(k, [row]);
        }
    }
    return map;
}

export async function createAnnotation(
    db: DatabaseClient<BoardsDb>,
    input: {
        boardSlug: string;
        cardId: number;
        region: Region;
        intent: string;
        intentOther?: string;
        prompt: string;
        createdBy?: string;
        assignee?: string;
        status?: "staged" | "open";
    }
): Promise<AnnotationDto> {
    const board = await db.kysely
        .selectFrom("boards")
        .select("id")
        .where("slug", "=", input.boardSlug)
        .executeTakeFirst();
    if (!board) {
        throw new NotFoundError(`board not found: ${input.boardSlug}`);
    }
    const card = await db.kysely
        .selectFrom("board_cards")
        .select(["id", "current_version"])
        .where("id", "=", input.cardId)
        .executeTakeFirst();
    if (!card) {
        throw new NotFoundError(`card not found: ${input.cardId}`);
    }

    const now = nowIso();
    return db.kysely.transaction().execute(async (trx) => {
        const inserted = await trx
            .insertInto("annotations")
            .values({
                board_id: board.id,
                card_id: input.cardId,
                region: SafeJSON.stringify(input.region),
                intent: input.intent,
                intent_other: input.intentOther ?? "",
                status: input.status ?? "staged",
                assignee: input.assignee ?? "claude",
                created_by: input.createdBy ?? "",
                card_version: card.current_version,
                claimed_by: "",
                claimed_listener: 0,
                claimed_at: "",
                created_at: now,
                updated_at: now,
            })
            .returningAll()
            .executeTakeFirstOrThrow();

        await trx
            .insertInto("annotation_revisions")
            .values({
                annotation_id: inserted.id,
                prompt: input.prompt,
                created_by: input.createdBy ?? "",
                created_at: now,
            })
            .execute();

        return loadAnnotationDto(trx, inserted.id);
    });
}

export async function getAnnotation(db: DatabaseClient<BoardsDb>, id: number): Promise<AnnotationDto> {
    return loadAnnotationDto(db.kysely, id);
}

/** Generic PATCH. Guards: cancelled → CancelledError; status must be in PATCHABLE_STATUSES.
 *  status → "working" is a claim CAS: only succeeds from "open". Setting any other status
 *  clears claimed_* columns. Also accepts region edits. Bumps updated_at. */
export async function patchAnnotation(
    db: DatabaseClient<BoardsDb>,
    id: number,
    patch: { status?: string; region?: Region; claimedBy?: string; claimedListener?: number }
): Promise<AnnotationDto> {
    const row = await db.kysely.selectFrom("annotations").select(["status"]).where("id", "=", id).executeTakeFirst();
    if (!row) {
        throw new NotFoundError(`annotation not found: ${id}`);
    }
    if (row.status === "cancelled") {
        throw new CancelledError(`annotation ${id} is cancelled`);
    }

    if (patch.status !== undefined) {
        if (!PATCHABLE_STATUSES.has(patch.status)) {
            throw new InvalidStatusError(`invalid status: ${patch.status}`);
        }
        if (patch.status === "working") {
            const result = await db.kysely
                .updateTable("annotations")
                .set({
                    status: "working",
                    claimed_by: patch.claimedBy ?? "claude",
                    claimed_listener: patch.claimedListener ?? 0,
                    claimed_at: nowIso(),
                    updated_at: nowIso(),
                })
                .where("id", "=", id)
                .where("status", "=", "open")
                .executeTakeFirst();
            if (Number(result.numUpdatedRows ?? 0) === 0) {
                throw new InvalidStatusError(`cannot claim annotation ${id}: not open`);
            }
        } else {
            await db.kysely
                .updateTable("annotations")
                .set({
                    status: patch.status,
                    claimed_by: "",
                    claimed_listener: 0,
                    claimed_at: "",
                    updated_at: nowIso(),
                })
                .where("id", "=", id)
                .execute();
        }
    }

    if (patch.region !== undefined) {
        await db.kysely
            .updateTable("annotations")
            .set({ region: SafeJSON.stringify(patch.region), updated_at: nowIso() })
            .where("id", "=", id)
            .execute();
    }

    return loadAnnotationDto(db.kysely, id);
}

export async function cancelAnnotation(db: DatabaseClient<BoardsDb>, id: number): Promise<AnnotationDto> {
    const row = await db.kysely.selectFrom("annotations").select(["status"]).where("id", "=", id).executeTakeFirst();
    if (!row) {
        throw new NotFoundError(`annotation not found: ${id}`);
    }
    if (!CANCELLABLE_FROM.has(row.status)) {
        throw new NotCancellableError(`annotation ${id} cannot be cancelled from status ${row.status}`);
    }
    await db.kysely
        .updateTable("annotations")
        .set({ status: "cancelled", claimed_by: "", claimed_listener: 0, claimed_at: "", updated_at: nowIso() })
        .where("id", "=", id)
        .execute();
    return loadAnnotationDto(db.kysely, id);
}

export async function reactivateAnnotation(db: DatabaseClient<BoardsDb>, id: number): Promise<AnnotationDto> {
    const row = await db.kysely.selectFrom("annotations").select(["status"]).where("id", "=", id).executeTakeFirst();
    if (!row) {
        throw new NotFoundError(`annotation not found: ${id}`);
    }
    if (row.status !== "cancelled") {
        throw new InvalidStatusError(`annotation ${id} is not cancelled`);
    }
    await db.kysely
        .updateTable("annotations")
        .set({ status: "staged", updated_at: nowIso() })
        .where("id", "=", id)
        .execute();
    return loadAnnotationDto(db.kysely, id);
}

export async function deleteAnnotation(db: DatabaseClient<BoardsDb>, id: number): Promise<void> {
    const row = await db.kysely.selectFrom("annotations").select(["status"]).where("id", "=", id).executeTakeFirst();
    if (!row) {
        throw new NotFoundError(`annotation not found: ${id}`);
    }
    if (row.status !== "staged" && row.status !== "open") {
        throw new NotUndoableError(`annotation ${id} cannot be deleted from status ${row.status}`);
    }
    const messageCount = await db.kysely
        .selectFrom("annotation_messages")
        .select(({ fn }) => fn.countAll<number>().as("n"))
        .where("annotation_id", "=", id)
        .executeTakeFirst();
    if (Number(messageCount?.n ?? 0) > 0) {
        throw new NotUndoableError(`annotation ${id} has messages`);
    }
    const attemptCount = await db.kysely
        .selectFrom("annotation_attempts")
        .select(({ fn }) => fn.countAll<number>().as("n"))
        .where("annotation_id", "=", id)
        .executeTakeFirst();
    if (Number(attemptCount?.n ?? 0) > 0) {
        throw new NotUndoableError(`annotation ${id} has attempts`);
    }
    // foreignKeys pragma is on: ON DELETE CASCADE takes its (pristine, single) revision row with it.
    await db.kysely.deleteFrom("annotations").where("id", "=", id).execute();
}

/** staged annotations EDIT the latest revision in place; anything else appends. */
export async function addRevision(
    db: DatabaseClient<BoardsDb>,
    id: number,
    prompt: string,
    createdBy: string
): Promise<AnnotationDto> {
    const row = await db.kysely.selectFrom("annotations").select(["status"]).where("id", "=", id).executeTakeFirst();
    if (!row) {
        throw new NotFoundError(`annotation not found: ${id}`);
    }
    if (row.status === "cancelled") {
        throw new CancelledError(`annotation ${id} is cancelled`);
    }

    const now = nowIso();
    if (row.status === "staged") {
        const latest = await db.kysely
            .selectFrom("annotation_revisions")
            .select("id")
            .where("annotation_id", "=", id)
            .orderBy("id", "desc")
            .executeTakeFirst();
        if (latest) {
            await db.kysely
                .updateTable("annotation_revisions")
                .set({ prompt, created_by: createdBy })
                .where("id", "=", latest.id)
                .execute();
        } else {
            await db.kysely
                .insertInto("annotation_revisions")
                .values({ annotation_id: id, prompt, created_by: createdBy, created_at: now })
                .execute();
        }
    } else {
        await db.kysely
            .insertInto("annotation_revisions")
            .values({ annotation_id: id, prompt, created_by: createdBy, created_at: now })
            .execute();
    }

    await db.kysely.updateTable("annotations").set({ updated_at: now }).where("id", "=", id).execute();
    return loadAnnotationDto(db.kysely, id);
}

export async function addMessage(
    db: DatabaseClient<BoardsDb>,
    input: { annotationId?: number; boardSlug?: string; author: string; body: string }
): Promise<MessageDto> {
    const hasAnnotation = input.annotationId !== undefined;
    const hasBoard = input.boardSlug !== undefined;
    if (hasAnnotation === hasBoard) {
        throw new Error("addMessage: exactly one of annotationId or boardSlug is required");
    }

    const now = nowIso();

    if (input.boardSlug !== undefined) {
        const board = await db.kysely
            .selectFrom("boards")
            .select("id")
            .where("slug", "=", input.boardSlug)
            .executeTakeFirst();
        if (!board) {
            throw new NotFoundError(`board not found: ${input.boardSlug}`);
        }
        const inserted = await db.kysely
            .insertInto("annotation_messages")
            .values({ annotation_id: 0, board_id: board.id, author: input.author, body: input.body, created_at: now })
            .returningAll()
            .executeTakeFirstOrThrow();
        return toMessageDto(inserted);
    }

    const annotationId = input.annotationId as number;
    const row = await db.kysely.selectFrom("annotations").selectAll().where("id", "=", annotationId).executeTakeFirst();
    if (!row) {
        throw new NotFoundError(`annotation not found: ${annotationId}`);
    }
    if (row.status === "cancelled") {
        throw new CancelledError(`annotation ${annotationId} is cancelled`);
    }

    const inserted = await db.kysely
        .insertInto("annotation_messages")
        .values({ annotation_id: annotationId, board_id: 0, author: input.author, body: input.body, created_at: now })
        .returningAll()
        .executeTakeFirstOrThrow();

    // A user reply (author != assignee) re-queues in-flight work; agent replies never change status.
    const isUserReply = input.author !== row.assignee;
    if (isUserReply && (row.status === "in_review" || row.status === "working")) {
        await db.kysely
            .updateTable("annotations")
            .set({ status: "open", claimed_by: "", claimed_listener: 0, claimed_at: "", updated_at: now })
            .where("id", "=", annotationId)
            .execute();
    }

    return toMessageDto(inserted);
}

export async function addAttempt(
    db: DatabaseClient<BoardsDb>,
    input: {
        annotationId: number;
        afterSetRef: string;
        afterVersion: number;
        afterFile: string;
        afterBlobKey: string;
        agent?: string;
        commitRef?: string;
    }
): Promise<{ attempt: AttemptDto; card: CardDto }> {
    const row = await db.kysely
        .selectFrom("annotations")
        .selectAll()
        .where("id", "=", input.annotationId)
        .executeTakeFirst();
    if (!row) {
        throw new NotFoundError(`annotation not found: ${input.annotationId}`);
    }
    if (row.status === "cancelled") {
        throw new CancelledError(`annotation ${input.annotationId} is cancelled`);
    }

    const latestRevision = await db.kysely
        .selectFrom("annotation_revisions")
        .select("id")
        .where("annotation_id", "=", input.annotationId)
        .orderBy("id", "desc")
        .executeTakeFirst();
    const now = nowIso();

    return db.kysely.transaction().execute(async (trx) => {
        const insertedAttempt = await trx
            .insertInto("annotation_attempts")
            .values({
                annotation_id: input.annotationId,
                revision_id: latestRevision?.id ?? 0,
                after_set_ref: input.afterSetRef,
                after_version: input.afterVersion,
                after_file: input.afterFile,
                after_blob_key: input.afterBlobKey,
                agent: input.agent ?? "claude",
                commit_ref: input.commitRef ?? "",
                verdict: "",
                created_at: now,
            })
            .returningAll()
            .executeTakeFirstOrThrow();

        const card = await trx.selectFrom("board_cards").selectAll().where("id", "=", row.card_id).executeTakeFirst();
        if (!card) {
            throw new NotFoundError(`card not found: ${row.card_id}`);
        }
        // appendCardVersion's logic, inlined: this driver has no nested-transaction/savepoint
        // support, so we cannot call the exported (self-transacting) helper from inside this tx.
        const nextVersion = await nextCardVersionNumber(trx, card.id);
        await trx
            .insertInto("card_versions")
            .values({
                card_id: card.id,
                version: nextVersion,
                set_ref: input.afterSetRef,
                set_version: input.afterVersion,
                file_path: input.afterFile,
                blob_key: input.afterBlobKey,
                attempt_id: insertedAttempt.id,
                created_at: now,
            })
            .execute();
        const updatedCard = await trx
            .updateTable("board_cards")
            .set({
                set_ref: input.afterSetRef,
                set_version: input.afterVersion,
                file_path: input.afterFile,
                blob_key: input.afterBlobKey,
                current_version: nextVersion,
                updated_at: now,
            })
            .where("id", "=", card.id)
            .returningAll()
            .executeTakeFirstOrThrow();

        return {
            attempt: {
                id: insertedAttempt.id,
                annotationId: insertedAttempt.annotation_id,
                revisionId: insertedAttempt.revision_id,
                afterSetRef: insertedAttempt.after_set_ref,
                afterVersion: insertedAttempt.after_version,
                afterFile: insertedAttempt.after_file,
                afterBlobKey: insertedAttempt.after_blob_key,
                agent: insertedAttempt.agent,
                commitRef: insertedAttempt.commit_ref,
                verdict: insertedAttempt.verdict as AttemptDto["verdict"],
                createdAt: insertedAttempt.created_at,
            },
            card: toCardDto(updatedCard),
        };
    });
}

/**
 * The highest card_versions row below `belowVersion` whose face was NOT itself a rejected
 * attempt (attempt_id === 0, i.e. not attempt-produced, always qualifies; an attempt-produced
 * version qualifies unless its own attempt's verdict is "reject"). Walks strictly downward so a
 * chain of rejects always lands on the last surviving (non-rejected) face.
 */
async function findRevertTarget(
    kysely: Kysely<BoardsDb>,
    cardId: number,
    belowVersion: number
): Promise<{ version: number; set_ref: string; set_version: number; file_path: string; blob_key: string } | undefined> {
    const candidates = await kysely
        .selectFrom("card_versions")
        .selectAll()
        .where("card_id", "=", cardId)
        .where("version", "<", belowVersion)
        .orderBy("version", "desc")
        .execute();
    for (const candidate of candidates) {
        if (candidate.attempt_id === 0) {
            return candidate;
        }
        const attempt = await kysely
            .selectFrom("annotation_attempts")
            .select("verdict")
            .where("id", "=", candidate.attempt_id)
            .executeTakeFirst();
        if (attempt?.verdict !== "reject") {
            return candidate;
        }
    }
    return undefined;
}

export async function setVerdict(
    db: DatabaseClient<BoardsDb>,
    attemptId: number,
    verdict: "accept" | "reject"
): Promise<{ attempt: AttemptDto; annotation: AnnotationDto; card: CardDto }> {
    const attemptRow = await db.kysely
        .selectFrom("annotation_attempts")
        .selectAll()
        .where("id", "=", attemptId)
        .executeTakeFirst();
    if (!attemptRow) {
        throw new NotFoundError(`attempt not found: ${attemptId}`);
    }
    const annotationRow = await db.kysely
        .selectFrom("annotations")
        .selectAll()
        .where("id", "=", attemptRow.annotation_id)
        .executeTakeFirst();
    if (!annotationRow) {
        throw new NotFoundError(`annotation not found: ${attemptRow.annotation_id}`);
    }

    const now = nowIso();
    const card = await db.kysely.transaction().execute(async (trx) => {
        await trx.updateTable("annotation_attempts").set({ verdict }).where("id", "=", attemptId).execute();

        if (verdict === "accept") {
            await trx
                .updateTable("annotations")
                .set({ status: "resolved", claimed_by: "", claimed_listener: 0, claimed_at: "", updated_at: now })
                .where("id", "=", annotationRow.id)
                .execute();
            return trx
                .selectFrom("board_cards")
                .selectAll()
                .where("id", "=", annotationRow.card_id)
                .executeTakeFirstOrThrow();
        }

        // reject: roll the card's live face back to the last surviving (non-rejected) version
        // that predates this attempt's appended version.
        const appended = await trx
            .selectFrom("card_versions")
            .select("version")
            .where("card_id", "=", annotationRow.card_id)
            .where("attempt_id", "=", attemptId)
            .executeTakeFirst();
        const target = appended ? await findRevertTarget(trx, annotationRow.card_id, appended.version) : undefined;
        if (!target) {
            throw new NotFoundError(`no prior version to revert to for card ${annotationRow.card_id}`);
        }
        return trx
            .updateTable("board_cards")
            .set({
                set_ref: target.set_ref,
                set_version: target.set_version,
                file_path: target.file_path,
                blob_key: target.blob_key,
                current_version: target.version,
                updated_at: now,
            })
            .where("id", "=", annotationRow.card_id)
            .returningAll()
            .executeTakeFirstOrThrow();
    });

    return {
        attempt: {
            id: attemptRow.id,
            annotationId: attemptRow.annotation_id,
            revisionId: attemptRow.revision_id,
            afterSetRef: attemptRow.after_set_ref,
            afterVersion: attemptRow.after_version,
            afterFile: attemptRow.after_file,
            afterBlobKey: attemptRow.after_blob_key,
            agent: attemptRow.agent,
            commitRef: attemptRow.commit_ref,
            verdict,
            createdAt: attemptRow.created_at,
        },
        annotation: await loadAnnotationDto(db.kysely, annotationRow.id),
        card: toCardDto(card),
    };
}

export async function listBoardMessages(db: DatabaseClient<BoardsDb>, boardSlug: string): Promise<MessageDto[]> {
    const board = await db.kysely.selectFrom("boards").select("id").where("slug", "=", boardSlug).executeTakeFirst();
    if (!board) {
        throw new NotFoundError(`board not found: ${boardSlug}`);
    }
    const rows = await db.kysely
        .selectFrom("annotation_messages")
        .selectAll()
        .where("board_id", "=", board.id)
        .orderBy("id", "asc")
        .execute();
    return rows.map(toMessageDto);
}
