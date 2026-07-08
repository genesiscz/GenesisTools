import type { DatabaseClient } from "@app/utils/database/client";
import { SafeJSON } from "@app/utils/json";
import type { Kysely, Selectable } from "kysely";
import { getBoardAnnotations } from "./annotations-store";
import type { BoardCardsTable, BoardEdgesTable, BoardStrokesTable, BoardsDb, BoardsTable } from "./db-types";
import { NotFoundError, setRefOf } from "./sets-store";
import { nowIso } from "./time";
import type {
    BoardDocDto,
    BoardSummaryDto,
    CardDto,
    EdgeDto,
    MessageDto,
    QuestionDto,
    SetDetailDto,
    StrokeDto,
} from "./types";

export const BOARD_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const RESERVED_SLUGS = new Set([
    "sets",
    "work",
    "cards",
    "annotations",
    "attempts",
    "strokes",
    "edges",
    "blobs",
    "questions",
    "operator",
    "trash",
]);

export class SlugConflictError extends Error {}

const IMPORT_COLS = 4;
const IMPORT_CELL_W = 420;
const IMPORT_GAP = 48;

function toBoardDto(row: Selectable<BoardsTable>): BoardSummaryDto {
    return {
        id: row.id,
        slug: row.slug,
        title: row.title,
        project: row.project,
        boardType: row.board_type,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        archived: row.archived_at !== "",
    };
}

/** Exported for work-store.ts's listOpenWorkDetailed (boards-store -> work-store is the one
 *  intended cross-module edge; work-store never gets imported back, so no cycle). */
export function toCardDto(row: Selectable<BoardCardsTable>): CardDto {
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

function toStrokeDto(row: Selectable<BoardStrokesTable>): StrokeDto {
    return {
        id: row.id,
        boardId: row.board_id,
        cardId: row.card_id === 0 ? null : row.card_id,
        path: SafeJSON.parse(row.path, { strict: true }) as number[][],
        color: row.color,
        width: row.width,
        createdBy: row.created_by,
    };
}

function toEdgeDto(row: Selectable<BoardEdgesTable>): EdgeDto {
    return {
        id: row.id,
        boardId: row.board_id,
        fromCard: row.from_card,
        toCard: row.to_card === 0 ? null : row.to_card,
        toX: row.to_x,
        toY: row.to_y,
        label: row.label,
    };
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

function toQuestionDto(row: {
    id: number;
    board_id: number;
    card_id: number;
    prompt: string;
    options: string;
    answer: string;
    answered_by: string;
    delivered: number;
    staged: number;
    multi: number;
    created_at: string;
    answered_at: string;
}): QuestionDto {
    return {
        id: row.id,
        boardId: row.board_id,
        cardId: row.card_id === 0 ? null : row.card_id,
        prompt: row.prompt,
        options: SafeJSON.parse(row.options || "[]", { strict: true }) as QuestionDto["options"],
        answer: row.answer ? (SafeJSON.parse(row.answer, { strict: true }) as string[]) : null,
        answeredBy: row.answered_by,
        staged: row.staged === 1,
        multi: row.multi === 1,
        createdAt: row.created_at,
        answeredAt: row.answered_at,
    };
}

async function getBoardRow(db: DatabaseClient<BoardsDb>, slug: string): Promise<Selectable<BoardsTable>> {
    const row = await db.kysely.selectFrom("boards").selectAll().where("slug", "=", slug).executeTakeFirst();
    if (!row) {
        throw new NotFoundError(`board not found: ${slug}`);
    }
    return row;
}

export async function createBoard(
    db: DatabaseClient<BoardsDb>,
    input: { slug: string; title?: string; boardType?: string; project?: string }
): Promise<BoardSummaryDto> {
    if (!BOARD_SLUG_RE.test(input.slug) || RESERVED_SLUGS.has(input.slug)) {
        throw new SlugConflictError(`invalid board slug: ${input.slug}`);
    }
    const existing = await db.kysely
        .selectFrom("boards")
        .select("id")
        .where("slug", "=", input.slug)
        .executeTakeFirst();
    if (existing) {
        throw new SlugConflictError(`board slug already exists: ${input.slug}`);
    }
    const now = nowIso();
    const inserted = await db.kysely
        .insertInto("boards")
        .values({
            slug: input.slug,
            title: input.title ?? "",
            project: input.project ?? "",
            board_type: input.boardType ?? "board",
            elem_seq: 0,
            created_at: now,
            updated_at: now,
            archived_at: "",
        })
        .returningAll()
        .executeTakeFirstOrThrow();
    return toBoardDto(inserted);
}

export async function listBoards(
    db: DatabaseClient<BoardsDb>,
    project?: string
): Promise<Array<BoardSummaryDto & { cardCount: number; openWork: number }>> {
    let q = db.kysely.selectFrom("boards").selectAll();
    if (project) {
        q = q.where("project", "=", project);
    }
    const boards = await q.orderBy("updated_at", "desc").execute();
    if (boards.length === 0) {
        return [];
    }

    const boardIds = boards.map((b) => b.id);
    const cardCounts = await db.kysely
        .selectFrom("board_cards")
        .select((eb) => ["board_id", eb.fn.countAll<number>().as("n")])
        .where("board_id", "in", boardIds)
        .where("deleted_at", "=", "")
        .groupBy("board_id")
        .execute();
    const openWork = await db.kysely
        .selectFrom("annotations")
        .select((eb) => ["board_id", eb.fn.countAll<number>().as("n")])
        .where("board_id", "in", boardIds)
        .where("status", "=", "open")
        .groupBy("board_id")
        .execute();

    const cardCountByBoard = new Map(cardCounts.map((r) => [r.board_id, Number(r.n)]));
    const openWorkByBoard = new Map(openWork.map((r) => [r.board_id, Number(r.n)]));

    return boards.map((b) => ({
        ...toBoardDto(b),
        cardCount: cardCountByBoard.get(b.id) ?? 0,
        openWork: openWorkByBoard.get(b.id) ?? 0,
    }));
}

export async function getBoardBySlug(db: DatabaseClient<BoardsDb>, slug: string): Promise<BoardSummaryDto> {
    return toBoardDto(await getBoardRow(db, slug));
}

export async function patchBoard(
    db: DatabaseClient<BoardsDb>,
    slug: string,
    patch: { title?: string; project?: string; archived?: boolean }
): Promise<BoardSummaryDto> {
    const row = await getBoardRow(db, slug);
    const archivedAt = patch.archived === undefined ? row.archived_at : patch.archived ? nowIso() : "";
    const updated = await db.kysely
        .updateTable("boards")
        .set({
            title: patch.title ?? row.title,
            project: patch.project ?? row.project,
            archived_at: archivedAt,
            updated_at: nowIso(),
        })
        .where("id", "=", row.id)
        .returningAll()
        .executeTakeFirstOrThrow();
    return toBoardDto(updated);
}

export async function getBoardDoc(db: DatabaseClient<BoardsDb>, slug: string): Promise<BoardDocDto> {
    const board = await getBoardRow(db, slug);

    const cardRows = await db.kysely
        .selectFrom("board_cards")
        .selectAll()
        .where("board_id", "=", board.id)
        .where("deleted_at", "=", "")
        .orderBy("z", "asc")
        .execute();
    const strokeRows = await db.kysely
        .selectFrom("board_strokes")
        .selectAll()
        .where("board_id", "=", board.id)
        .orderBy("id", "asc")
        .execute();
    const edgeRows = await db.kysely
        .selectFrom("board_edges")
        .selectAll()
        .where("board_id", "=", board.id)
        .orderBy("id", "asc")
        .execute();
    const messageRows = await db.kysely
        .selectFrom("annotation_messages")
        .selectAll()
        .where("board_id", "=", board.id)
        .orderBy("created_at", "asc")
        .execute();
    const questionRows = await db.kysely
        .selectFrom("board_questions")
        .selectAll()
        .where("board_id", "=", board.id)
        .orderBy("created_at", "asc")
        .execute();

    return {
        board: toBoardDto(board),
        cards: cardRows.map(toCardDto),
        strokes: strokeRows.map(toStrokeDto),
        edges: edgeRows.map(toEdgeDto),
        annotations: await getBoardAnnotations(db, board.id, board.slug),
        boardMessages: messageRows.map(toMessageDto),
        questions: questionRows.map(toQuestionDto),
    };
}

export async function createCard(
    db: DatabaseClient<BoardsDb>,
    boardSlug: string,
    input: {
        kind: string;
        x: number;
        y: number;
        w: number;
        h: number;
        z?: number;
        setRef?: string;
        setVersion?: number;
        filePath?: string;
        blobKey?: string;
        payload?: Record<string, unknown>;
        createdBy?: string;
    }
): Promise<CardDto> {
    const now = nowIso();
    return db.kysely.transaction().execute(async (trx) => {
        const board = await trx.selectFrom("boards").selectAll().where("slug", "=", boardSlug).executeTakeFirst();
        if (!board) {
            throw new NotFoundError(`board not found: ${boardSlug}`);
        }
        const elemNo = board.elem_seq + 1;
        await trx.updateTable("boards").set({ elem_seq: elemNo, updated_at: now }).where("id", "=", board.id).execute();

        const inserted = await trx
            .insertInto("board_cards")
            .values({
                board_id: board.id,
                kind: input.kind,
                x: input.x,
                y: input.y,
                w: input.w,
                h: input.h,
                z: input.z ?? 0,
                set_ref: input.setRef ?? "",
                set_version: input.setVersion ?? 0,
                file_path: input.filePath ?? "",
                blob_key: input.blobKey ?? "",
                payload: SafeJSON.stringify(input.payload ?? {}),
                created_by: input.createdBy ?? "",
                elem_no: elemNo,
                current_version: 1,
                deleted_at: "",
                created_at: now,
                updated_at: now,
            })
            .returningAll()
            .executeTakeFirstOrThrow();

        // Shot/media cards carry a blob (image); seed their v1 history row.
        if (inserted.blob_key) {
            await trx
                .insertInto("card_versions")
                .values({
                    card_id: inserted.id,
                    version: 1,
                    set_ref: inserted.set_ref,
                    set_version: inserted.set_version,
                    file_path: inserted.file_path,
                    blob_key: inserted.blob_key,
                    attempt_id: 0,
                    created_at: now,
                })
                .execute();
        }

        return toCardDto(inserted);
    });
}

/** Fetches a single card by id (deleted or not — an open annotation's card can outlive a soft
 *  delete since soft-delete doesn't cascade to annotations; matches listOpenWorkDetailed's
 *  unfiltered lookup in work-store.ts so both capsule paths agree). Used by the capsule builder
 *  to pair a card with its annotation without pulling the whole board doc. */
export async function getCard(db: DatabaseClient<BoardsDb>, cardId: number): Promise<CardDto> {
    const row = await db.kysely.selectFrom("board_cards").selectAll().where("id", "=", cardId).executeTakeFirst();
    if (!row) {
        throw new NotFoundError(`card not found: ${cardId}`);
    }
    return toCardDto(row);
}

export async function patchCard(
    db: DatabaseClient<BoardsDb>,
    cardId: number,
    patch: Partial<{ x: number; y: number; w: number; h: number; z: number; payload: Record<string, unknown> }>
): Promise<CardDto> {
    const existing = await db.kysely.selectFrom("board_cards").selectAll().where("id", "=", cardId).executeTakeFirst();
    if (!existing) {
        throw new NotFoundError(`card not found: ${cardId}`);
    }
    const updated = await db.kysely
        .updateTable("board_cards")
        .set({
            x: patch.x ?? existing.x,
            y: patch.y ?? existing.y,
            w: patch.w ?? existing.w,
            h: patch.h ?? existing.h,
            z: patch.z ?? existing.z,
            payload: patch.payload !== undefined ? SafeJSON.stringify(patch.payload) : existing.payload,
            updated_at: nowIso(),
        })
        .where("id", "=", cardId)
        .returningAll()
        .executeTakeFirstOrThrow();
    return toCardDto(updated);
}

export async function softDeleteCard(db: DatabaseClient<BoardsDb>, cardId: number): Promise<void> {
    await db.kysely
        .updateTable("board_cards")
        .set({ deleted_at: nowIso(), updated_at: nowIso() })
        .where("id", "=", cardId)
        .execute();
}

export async function restoreCard(db: DatabaseClient<BoardsDb>, cardId: number): Promise<CardDto> {
    const updated = await db.kysely
        .updateTable("board_cards")
        .set({ deleted_at: "", updated_at: nowIso() })
        .where("id", "=", cardId)
        .returningAll()
        .executeTakeFirst();
    if (!updated) {
        throw new NotFoundError(`card not found: ${cardId}`);
    }
    return toCardDto(updated);
}

export async function listTrash(db: DatabaseClient<BoardsDb>, boardSlug: string): Promise<CardDto[]> {
    const board = await getBoardRow(db, boardSlug);
    const rows = await db.kysely
        .selectFrom("board_cards")
        .selectAll()
        .where("board_id", "=", board.id)
        .where("deleted_at", "!=", "")
        .orderBy("updated_at", "desc")
        .execute();
    return rows.map(toCardDto);
}

export async function addStrokes(
    db: DatabaseClient<BoardsDb>,
    boardSlug: string,
    strokes: Array<{ cardId?: number; path: number[][]; color?: string; width?: number; createdBy?: string }>
): Promise<StrokeDto[]> {
    const board = await getBoardRow(db, boardSlug);
    if (strokes.length === 0) {
        return [];
    }
    const now = nowIso();
    const inserted = await db.kysely
        .insertInto("board_strokes")
        .values(
            strokes.map((s) => ({
                board_id: board.id,
                card_id: s.cardId ?? 0,
                path: SafeJSON.stringify(s.path),
                color: s.color ?? "#e33",
                width: s.width ?? 3,
                created_by: s.createdBy ?? "",
                created_at: now,
            }))
        )
        .returningAll()
        .execute();
    return inserted.map(toStrokeDto);
}

export async function deleteStroke(db: DatabaseClient<BoardsDb>, strokeId: number): Promise<void> {
    await db.kysely.deleteFrom("board_strokes").where("id", "=", strokeId).execute();
}

export async function addEdge(
    db: DatabaseClient<BoardsDb>,
    boardSlug: string,
    edge: { fromCard: number; toCard?: number; toX?: number; toY?: number; label?: string; createdBy?: string }
): Promise<EdgeDto> {
    const board = await getBoardRow(db, boardSlug);
    const now = nowIso();
    const inserted = await db.kysely
        .insertInto("board_edges")
        .values({
            board_id: board.id,
            from_card: edge.fromCard,
            to_card: edge.toCard ?? 0,
            to_x: edge.toX ?? 0,
            to_y: edge.toY ?? 0,
            label: edge.label ?? "",
            created_by: edge.createdBy ?? "",
            created_at: now,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
    return toEdgeDto(inserted);
}

export async function deleteEdge(db: DatabaseClient<BoardsDb>, edgeId: number): Promise<void> {
    await db.kysely.deleteFrom("board_edges").where("id", "=", edgeId).execute();
}

export async function bulkLayout(
    db: DatabaseClient<BoardsDb>,
    boardSlug: string,
    moves: Array<{ id: number; x: number; y: number }>
): Promise<void> {
    if (moves.length < 1 || moves.length > 500) {
        throw new Error(`bulkLayout: expected 1-500 moves, got ${moves.length}`);
    }
    const board = await getBoardRow(db, boardSlug);
    const now = nowIso();
    await db.kysely.transaction().execute(async (trx) => {
        for (const m of moves) {
            await trx
                .updateTable("board_cards")
                .set({ x: m.x, y: m.y, updated_at: now })
                .where("id", "=", m.id)
                .where("board_id", "=", board.id)
                .execute();
        }
    });
}

/**
 * The next version number to append for a card. MUST be derived from MAX(card_versions.version),
 * not from board_cards.current_version: after a reject reverts the current_version pointer
 * backward, the append-only history still holds the higher (rejected) version row, so
 * `current_version + 1` would collide with it under the (card_id, version) UNIQUE constraint.
 */
async function nextCardVersionNumber(kysely: Kysely<BoardsDb>, cardId: number): Promise<number> {
    const row = await kysely
        .selectFrom("card_versions")
        .select(({ fn }) => fn.max("version").as("maxVersion"))
        .where("card_id", "=", cardId)
        .executeTakeFirst();
    return Number(row?.maxVersion ?? 0) + 1;
}

/** Deterministic serpentine grid layout for a fresh import. */
function serpentinePositions(heights: number[]): Array<{ x: number; y: number }> {
    const positions: Array<{ x: number; y: number }> = [];
    const rows = Math.ceil(heights.length / IMPORT_COLS);
    let yOffset = 0;
    for (let r = 0; r < rows; r += 1) {
        const rowStart = r * IMPORT_COLS;
        const rowEnd = Math.min(rowStart + IMPORT_COLS, heights.length);
        const rowHeights = heights.slice(rowStart, rowEnd);
        const rowH = Math.max(...rowHeights);
        for (let i = rowStart; i < rowEnd; i += 1) {
            const colInRow = i - rowStart;
            const c = r % 2 === 0 ? colInRow : IMPORT_COLS - 1 - colInRow;
            positions.push({ x: c * (IMPORT_CELL_W + IMPORT_GAP), y: yOffset });
        }
        yOffset += rowH + IMPORT_GAP;
    }
    return positions;
}

export async function importSet(
    db: DatabaseClient<BoardsDb>,
    boardSlug: string,
    set: SetDetailDto
): Promise<{ cards: CardDto[]; edges: EdgeDto[]; skipped: number }> {
    const board = await getBoardRow(db, boardSlug);
    const setRef = setRefOf(set);
    const images = set.files.filter((f) => f.width > 0 && f.height > 0);

    const existingRows = await db.kysely
        .selectFrom("board_cards")
        .select(["file_path"])
        .where("board_id", "=", board.id)
        .where("set_ref", "=", setRef)
        .where("deleted_at", "=", "")
        .execute();
    const existingPaths = new Set(existingRows.map((r) => r.file_path));

    const toImport = images.filter((f) => !existingPaths.has(f.path));
    const skipped = images.length - toImport.length;
    const heights = toImport.map((f) => Math.round((IMPORT_CELL_W * f.height) / f.width));
    const positions = serpentinePositions(heights);
    const now = nowIso();

    return db.kysely.transaction().execute(async (trx) => {
        const cards: CardDto[] = [];
        let elemSeq = board.elem_seq;

        for (let i = 0; i < toImport.length; i += 1) {
            const f = toImport[i];
            elemSeq += 1;
            const inserted = await trx
                .insertInto("board_cards")
                .values({
                    board_id: board.id,
                    kind: "shot",
                    x: positions[i].x,
                    y: positions[i].y,
                    w: IMPORT_CELL_W,
                    h: heights[i],
                    z: i,
                    set_ref: setRef,
                    set_version: set.version,
                    file_path: f.path,
                    blob_key: f.blobKey,
                    payload: SafeJSON.stringify({ naturalWidth: f.width, naturalHeight: f.height }),
                    created_by: "",
                    elem_no: elemSeq,
                    current_version: 1,
                    deleted_at: "",
                    created_at: now,
                    updated_at: now,
                })
                .returningAll()
                .executeTakeFirstOrThrow();

            await trx
                .insertInto("card_versions")
                .values({
                    card_id: inserted.id,
                    version: 1,
                    set_ref: setRef,
                    set_version: set.version,
                    file_path: f.path,
                    blob_key: f.blobKey,
                    attempt_id: 0,
                    created_at: now,
                })
                .execute();

            cards.push(toCardDto(inserted));
        }

        await trx
            .updateTable("boards")
            .set({ elem_seq: elemSeq, project: board.project || set.project, updated_at: now })
            .where("id", "=", board.id)
            .execute();

        const edges: EdgeDto[] = [];
        for (let i = 0; i + 1 < cards.length; i += 1) {
            const nextMeta = toImport[i + 1].meta as { action?: string };
            const inserted = await trx
                .insertInto("board_edges")
                .values({
                    board_id: board.id,
                    from_card: cards[i].id,
                    to_card: cards[i + 1].id,
                    to_x: 0,
                    to_y: 0,
                    label: nextMeta.action ?? "",
                    created_by: "",
                    created_at: now,
                })
                .returningAll()
                .executeTakeFirstOrThrow();
            edges.push(toEdgeDto(inserted));
        }

        return { cards, edges, skipped };
    });
}

export async function syncSetCards(
    db: DatabaseClient<BoardsDb>,
    boardSlug: string,
    set: SetDetailDto
): Promise<{ updated: number; skippedFiles: string[] }> {
    const board = await getBoardRow(db, boardSlug);
    const setRef = setRefOf(set);
    const staleCards = await db.kysely
        .selectFrom("board_cards")
        .selectAll()
        .where("board_id", "=", board.id)
        .where("set_ref", "=", setRef)
        .where("set_version", "<", set.version)
        .where("deleted_at", "=", "")
        .execute();

    const filesByPath = new Map(set.files.map((f) => [f.path, f]));
    const skippedFiles: string[] = [];
    let updated = 0;
    const now = nowIso();

    await db.kysely.transaction().execute(async (trx) => {
        for (const card of staleCards) {
            const file = filesByPath.get(card.file_path);
            if (!file) {
                skippedFiles.push(card.file_path);
                continue;
            }
            const nextVersion = await nextCardVersionNumber(trx, card.id);
            await trx
                .insertInto("card_versions")
                .values({
                    card_id: card.id,
                    version: nextVersion,
                    set_ref: setRef,
                    set_version: set.version,
                    file_path: file.path,
                    blob_key: file.blobKey,
                    attempt_id: 0,
                    created_at: now,
                })
                .execute();
            const payload = SafeJSON.parse(card.payload || "{}", { strict: true }) as Record<string, unknown>;
            await trx
                .updateTable("board_cards")
                .set({
                    blob_key: file.blobKey,
                    set_version: set.version,
                    current_version: nextVersion,
                    payload: SafeJSON.stringify({
                        ...payload,
                        naturalWidth: file.width,
                        naturalHeight: file.height,
                    }),
                    updated_at: now,
                })
                .where("id", "=", card.id)
                .execute();
            updated += 1;
        }
    });

    return { updated, skippedFiles };
}

export async function appendCardVersion(
    db: DatabaseClient<BoardsDb>,
    cardId: number,
    v: { setRef: string; setVersion: number; filePath: string; blobKey: string; attemptId?: number }
): Promise<number> {
    const card = await db.kysely.selectFrom("board_cards").selectAll().where("id", "=", cardId).executeTakeFirst();
    if (!card) {
        throw new NotFoundError(`card not found: ${cardId}`);
    }
    const now = nowIso();
    return db.kysely.transaction().execute(async (trx) => {
        const nextVersion = await nextCardVersionNumber(trx, cardId);
        await trx
            .insertInto("card_versions")
            .values({
                card_id: cardId,
                version: nextVersion,
                set_ref: v.setRef,
                set_version: v.setVersion,
                file_path: v.filePath,
                blob_key: v.blobKey,
                attempt_id: v.attemptId ?? 0,
                created_at: now,
            })
            .execute();
        await trx
            .updateTable("board_cards")
            .set({
                set_ref: v.setRef,
                set_version: v.setVersion,
                file_path: v.filePath,
                blob_key: v.blobKey,
                current_version: nextVersion,
                updated_at: now,
            })
            .where("id", "=", cardId)
            .execute();
        return nextVersion;
    });
}

/** Known limitation: `card_versions` doesn't store width/height, so a revert leaves
 *  `payload.naturalWidth/naturalHeight` at whatever the rejected attempt's face set them
 *  to, rather than restoring the prior face's dims. Accepted as-is: the common reject
 *  case is a same-dimension reshoot, and CompareDeck's own overlay reads the live <img>'s
 *  naturalWidth rather than payload, so the deck is unaffected either way. */
export async function revertCardFace(
    db: DatabaseClient<BoardsDb>,
    cardId: number,
    toVersion: number
): Promise<CardDto> {
    const versionRow = await db.kysely
        .selectFrom("card_versions")
        .selectAll()
        .where("card_id", "=", cardId)
        .where("version", "=", toVersion)
        .executeTakeFirst();
    if (!versionRow) {
        throw new NotFoundError(`card version not found: card ${cardId} v${toVersion}`);
    }
    const updated = await db.kysely
        .updateTable("board_cards")
        .set({
            set_ref: versionRow.set_ref,
            set_version: versionRow.set_version,
            file_path: versionRow.file_path,
            blob_key: versionRow.blob_key,
            current_version: toVersion,
            updated_at: nowIso(),
        })
        .where("id", "=", cardId)
        .returningAll()
        .executeTakeFirst();
    if (!updated) {
        throw new NotFoundError(`card not found: ${cardId}`);
    }
    return toCardDto(updated);
}

export async function listCardVersions(
    db: DatabaseClient<BoardsDb>,
    cardId: number
): Promise<
    Array<{
        version: number;
        setRef: string;
        setVersion: number;
        filePath: string;
        blobKey: string;
        attemptId: number | null;
        createdAt: string;
    }>
> {
    const rows = await db.kysely
        .selectFrom("card_versions")
        .selectAll()
        .where("card_id", "=", cardId)
        .orderBy("version", "asc")
        .execute();
    return rows.map((r) => ({
        version: r.version,
        setRef: r.set_ref,
        setVersion: r.set_version,
        filePath: r.file_path,
        blobKey: r.blob_key,
        attemptId: r.attempt_id === 0 ? null : r.attempt_id,
        createdAt: r.created_at,
    }));
}
