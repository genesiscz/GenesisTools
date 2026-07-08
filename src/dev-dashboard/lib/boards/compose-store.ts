import type { DatabaseClient } from "@app/utils/database/client";
import { SafeJSON } from "@app/utils/json";
import { getBoardDoc, listTrash, patchCard, restoreCard, softDeleteCard, toCardDto } from "./boards-store";
import {
    COMPOSE_GAP,
    COMPOSE_GRID,
    COMPOSE_GUTTER,
    COMPOSE_MAX_CARDS,
    COMPOSE_MAX_EDGES,
    COMPOSE_MAX_QUESTIONS,
    type ComposeErrorCode,
    type ComposeKind,
    type ComposeRef,
    MAX_QUESTION_PROMPT,
    QUESTION_ROOM,
    SECTION_PAD_BOT,
    SECTION_PAD_TOP,
    SECTION_PAD_X,
} from "./compose-types";
import { composeDefaultSize, normalizeOptions, stampLayer, validateComposeCard } from "./compose-validate";
import type { BoardsDb } from "./db-types";
import { notifyLayoutChanged } from "./layout-engine";
import { containingSection, resolveJourneyPass, type SectionCard, sectionByName, sectionFrames } from "./sections";
import { nowIso } from "./time";
import type { CardDto, EdgeDto, QuestionDto } from "./types";

const ZERO_H = 220; // legacy zero-height card footprint for member-bottom math

export interface ComposeCardInput {
    ref?: string;
    kind: string;
    payload?: Record<string, unknown>;
    w?: number;
    h?: number;
    children?: string[];
}
export interface ComposeEdgeInput {
    from: ComposeRef;
    to: ComposeRef;
    label?: string;
}
export interface ComposeQuestionInput {
    prompt: string;
    options: unknown[];
    multiSelect?: boolean;
    cardRef?: string;
    cardId?: number;
}
export interface ComposeBody {
    layout?: string;
    section?: string;
    journey?: string;
    pass?: number | "next";
    anchorCardId?: number;
    cards: ComposeCardInput[];
    edges?: ComposeEdgeInput[];
    questions?: ComposeQuestionInput[];
}

export interface ComposeRegion {
    x: number;
    y: number;
    w: number;
    h: number;
}
export type ComposeResult =
    | {
          ok: true;
          cards: Array<{ id: number; elemNo: number; ref?: string }>;
          edges: number[];
          questions: number[];
          region: ComposeRegion;
          events: { cards: CardDto[]; edges: EdgeDto[]; questions: QuestionDto[]; boardId: number };
      }
    | { ok: false; code: ComposeErrorCode; index: number; message: string };

interface PlaceCard {
    kind: ComposeKind;
    x: number;
    y: number;
    w: number;
    h: number;
}

function err(code: ComposeErrorCode, index: number, message: string): ComposeResult {
    return { ok: false, code, index, message };
}

/** composePlace (handlers_compose.go:640-748): assign x/y to the batch in place, growing cluster/
 *  section frames around their children, and return the covered region. */
function composePlace(opts: {
    cards: PlaceCard[];
    existing: SectionCard[];
    anchor: SectionCard | null;
    origin: { x: number; y: number } | null;
    mode: string;
    withQuestion: Set<number>;
    childParent: Map<number, number>;
}): ComposeRegion {
    const { cards, existing, anchor, origin, mode, withQuestion, childParent } = opts;
    const CLUSTER_PAD_X = 20;
    const CLUSTER_PAD_TOP = 44;
    const CLUSTER_PAD_BOT = 20;

    // Cluster/section inner pass: members flow 2-per-row inside their frame (relative coords).
    const childrenOf = new Map<number, number[]>();
    for (const [child, parent] of childParent) {
        const list = childrenOf.get(parent) ?? [];
        list.push(child);
        childrenOf.set(parent, list);
    }
    for (const [parent, kids] of childrenOf) {
        kids.sort((a, b) => a - b);
        const padTop = cards[parent].kind === "section" ? SECTION_PAD_TOP : CLUSTER_PAD_TOP;
        let x = 0;
        let y = 0;
        let rowH = 0;
        let maxW = 0;
        kids.forEach((ci, n) => {
            if (n > 0 && n % 2 === 0) {
                x = 0;
                y += rowH + COMPOSE_GAP;
                rowH = 0;
            }
            cards[ci].x = x;
            cards[ci].y = y;
            const h = cards[ci].h + (withQuestion.has(ci) ? QUESTION_ROOM : 0);
            rowH = Math.max(rowH, h);
            maxW = Math.max(maxW, x + cards[ci].w);
            x += cards[ci].w + COMPOSE_GAP;
        });
        cards[parent].w = maxW + 2 * CLUSTER_PAD_X;
        cards[parent].h = y + rowH + padTop + CLUSTER_PAD_BOT;
    }

    let ox = 80;
    let oy = 80;
    if (origin) {
        ox = origin.x;
        oy = origin.y;
    } else if (anchor) {
        const aw = anchor.w > 0 ? anchor.w : 340;
        ox = anchor.x + aw + COMPOSE_GUTTER;
        oy = anchor.y;
    } else if (existing.length > 0) {
        let maxX = Number.NEGATIVE_INFINITY;
        let minY = Number.POSITIVE_INFINITY;
        for (const c of existing) {
            const cw = c.w > 0 ? c.w : 340;
            maxX = Math.max(maxX, c.x + cw);
            minY = Math.min(minY, c.y);
        }
        ox = maxX + COMPOSE_GUTTER;
        oy = minY;
    }
    if (!origin) {
        ox = Math.round(ox / COMPOSE_GRID) * COMPOSE_GRID;
        oy = Math.round(oy / COMPOSE_GRID) * COMPOSE_GRID;
    }

    let perRow = 1;
    if (mode === "row") {
        perRow = cards.length;
    } else if (mode === "grid" || mode === "none") {
        perRow = 3;
    }
    if (perRow < 1) {
        perRow = 1;
    }

    let x = ox;
    let y = oy;
    let rowH = 0;
    let maxX = ox;
    let maxY = oy;
    let n = 0;
    for (let i = 0; i < cards.length; i += 1) {
        if (childParent.has(i)) {
            continue; // placed relative to its frame below
        }
        if (n > 0 && n % perRow === 0) {
            x = ox;
            y += rowH + COMPOSE_GAP;
            rowH = 0;
        }
        cards[i].x = x;
        cards[i].y = y;
        const h = cards[i].h + (withQuestion.has(i) ? QUESTION_ROOM : 0);
        rowH = Math.max(rowH, h);
        maxX = Math.max(maxX, x + cards[i].w);
        maxY = Math.max(maxY, y + h);
        x += cards[i].w + COMPOSE_GAP;
        n += 1;
    }

    // Children go absolute: frame origin + inner padding + their relative slot.
    for (const [child, parent] of childParent) {
        cards[child].x += cards[parent].x + CLUSTER_PAD_X;
        cards[child].y += cards[parent].y + (cards[parent].kind === "section" ? SECTION_PAD_TOP : CLUSTER_PAD_TOP);
    }

    return { x: ox, y: oy, w: maxX - ox, h: maxY - oy };
}

function resolveRefIndex(cr: ComposeRef, refIdx: Map<string, number>): { idx: number; id: number } | null {
    if (typeof cr === "string") {
        const i = refIdx.get(cr);
        return i === undefined ? null : { idx: i, id: 0 };
    }
    if (typeof cr === "number" && cr > 0) {
        return { idx: -1, id: cr };
    }
    return null;
}

/** Batched AI card/edge/question authoring with server-side placement. All-or-nothing: everything
 *  is validated first, then written in ONE transaction (handlers_compose.go:139-574). */
export async function composeBoard(
    db: DatabaseClient<BoardsDb>,
    slug: string,
    body: ComposeBody,
    actor = "claude"
): Promise<ComposeResult> {
    const cardsIn = body.cards ?? [];
    const edgesIn = body.edges ?? [];
    const questionsIn = body.questions ?? [];

    if (cardsIn.length === 0 && edgesIn.length === 0 && questionsIn.length === 0) {
        return err("empty", -1, "empty batch: send cards, edges or questions");
    }
    if (cardsIn.length > COMPOSE_MAX_CARDS) {
        return err("limit", -1, `max ${COMPOSE_MAX_CARDS} cards per compose`);
    }
    if (edgesIn.length > COMPOSE_MAX_EDGES) {
        return err("limit", -1, `max ${COMPOSE_MAX_EDGES} edges per compose`);
    }
    if (questionsIn.length > COMPOSE_MAX_QUESTIONS) {
        return err("limit", -1, `max ${COMPOSE_MAX_QUESTIONS} questions per compose`);
    }

    // Load board + live cards (validation + placement operate on this snapshot).
    const board = await db.kysely.selectFrom("boards").selectAll().where("slug", "=", slug).executeTakeFirst();
    if (!board) {
        return err("not_found", -1, `board not found: ${slug}`);
    }
    const existingRows = await db.kysely
        .selectFrom("board_cards")
        .selectAll()
        .where("board_id", "=", board.id)
        .where("deleted_at", "=", "")
        .execute();
    const existing: SectionCard[] = existingRows.map(toCardDto);
    const existingIds = new Set(existing.map((c) => c.id));

    // 1) Cards: validate kind + payload, stamp layer, size; track batch refs.
    const refIdx = new Map<string, number>();
    const placed: PlaceCard[] = [];
    const payloads: Array<Record<string, unknown>> = [];
    for (let i = 0; i < cardsIn.length; i += 1) {
        const c = cardsIn[i];
        const v = validateComposeCard({ kind: c.kind, payload: c.payload ?? {} });
        if (!v.ok) {
            return err(v.code, i, `card ${i}: ${v.code}`);
        }
        const size = composeDefaultSize(c.kind as ComposeKind, v.payload);
        placed.push({
            kind: c.kind as ComposeKind,
            x: 0,
            y: 0,
            w: c.w && c.w > 0 ? c.w : size.w,
            h: c.h && c.h > 0 ? c.h : size.h,
        });
        payloads.push(v.payload);
        if (c.ref) {
            if (refIdx.has(c.ref)) {
                return err("bad_ref", i, `duplicate ref "${c.ref}"`);
            }
            refIdx.set(c.ref, i);
        }
    }

    // 2) Edges: resolve from/to refs.
    const edgeResolved: Array<{ fromIdx: number; fromId: number; toIdx: number; toId: number; label: string }> = [];
    for (let i = 0; i < edgesIn.length; i += 1) {
        const e = edgesIn[i];
        const from = resolveRefIndex(e.from, refIdx);
        if (!from || (from.id > 0 && !existingIds.has(from.id))) {
            return err("bad_ref", i, `edge from: no such ref/card in this batch or board`);
        }
        const to = resolveRefIndex(e.to, refIdx);
        if (!to || (to.id > 0 && !existingIds.has(to.id))) {
            return err("bad_ref", i, `edge to: no such ref/card in this batch or board`);
        }
        edgeResolved.push({ fromIdx: from.idx, fromId: from.id, toIdx: to.idx, toId: to.id, label: e.label ?? "" });
    }

    // 3) Questions: prompt, options, cardRef/cardId anchor.
    const withQuestion = new Set<number>();
    const questionResolved: Array<{
        prompt: string;
        options: string;
        multi: boolean;
        cardIdx: number;
        cardId: number;
    }> = [];
    for (let i = 0; i < questionsIn.length; i += 1) {
        const q = questionsIn[i];
        if (!q.prompt || q.prompt.length > MAX_QUESTION_PROMPT) {
            return err("bad_question", i, "question needs a prompt (≤1000 chars)");
        }
        let cardIdx = -1;
        if (q.cardRef) {
            const ci = refIdx.get(q.cardRef);
            if (ci === undefined) {
                return err("bad_ref", i, `question cardRef "${q.cardRef}": no such ref in this batch`);
            }
            cardIdx = ci;
            withQuestion.add(ci);
        }
        if (q.cardId && q.cardId > 0 && !existingIds.has(q.cardId)) {
            return err("not_found", i, `question cardId ${q.cardId} is not on this board`);
        }
        const opts = normalizeOptions(q.options);
        if (!opts.ok) {
            return err(opts.code, i, "question options: 1-12 of string|{label,hint?,recommended?}");
        }
        questionResolved.push({
            prompt: q.prompt,
            options: SafeJSON.stringify(opts.options),
            multi: q.multiSelect === true,
            cardIdx,
            cardId: q.cardId ?? 0,
        });
    }

    // 4) Children (cluster/section only; one parent; frames don't nest).
    const childParent = new Map<number, number>();
    for (let i = 0; i < cardsIn.length; i += 1) {
        const children = cardsIn[i].children;
        if (!children || children.length === 0) {
            continue;
        }
        if (cardsIn[i].kind !== "cluster" && cardsIn[i].kind !== "section") {
            return err("bad_payload", i, "children are only valid on cluster and section cards");
        }
        for (const ref of children) {
            const ci = refIdx.get(ref);
            if (ci === undefined) {
                return err("bad_ref", i, `cluster child "${ref}": no such ref in this batch`);
            }
            if (cardsIn[ci].kind === "cluster" || cardsIn[ci].kind === "section") {
                return err("bad_ref", i, "frames (cluster/section) cannot nest as children");
            }
            if (childParent.has(ci)) {
                return err("bad_ref", i, `card "${ref}" is already in another cluster`);
            }
            childParent.set(ci, i);
        }
    }

    // 5) Anchor / section / journey resolution (mutually exclusive).
    let anchor: SectionCard | null = null;
    if (body.anchorCardId && body.anchorCardId > 0) {
        anchor = existing.find((c) => c.id === body.anchorCardId) ?? null;
        if (!anchor) {
            return err("not_found", -1, `anchor card ${body.anchorCardId} is not on this board`);
        }
    }

    const frames = sectionFrames(existing);
    let targetFrame: { id?: number; x: number; y: number; w: number; h: number } | null = null;
    let adopt: { sectionId: number; journey: string } | null = null;
    let createFrame: { x: number; y: number; w: number; h: number; payload: Record<string, unknown> } | null = null;

    if (body.journey) {
        if (anchor || body.section) {
            return err("bad_payload", -1, "journey is mutually exclusive with anchor and section");
        }
        const res = resolveJourneyPass({ cards: existing, journey: body.journey, pass: body.pass });
        if (res.action === "error") {
            return err(res.code, -1, res.message);
        }
        if (res.action === "create") {
            createFrame = res.frame;
            targetFrame = { x: res.frame.x, y: res.frame.y, w: res.frame.w, h: res.frame.h };
        } else {
            if (res.action === "adopt") {
                adopt = { sectionId: res.section.id, journey: res.journey };
            }
            targetFrame = {
                id: res.section.id,
                x: res.section.x,
                y: res.section.y,
                w: res.section.w,
                h: res.section.h,
            };
        }
    }
    if (body.section) {
        if (anchor) {
            return err("bad_payload", -1, "anchor and section are mutually exclusive");
        }
        const sec = sectionByName(frames, body.section);
        if (!sec) {
            return err("not_found", -1, `no section named "${body.section}" on this board`);
        }
        targetFrame = { id: sec.id, x: sec.x, y: sec.y, w: sec.w, h: sec.h };
    }

    // 6) step/compare reference validation (their thumbnails render from existing cards' faces).
    for (let i = 0; i < placed.length; i += 1) {
        if (placed[i].kind !== "step" && placed[i].kind !== "compare") {
            continue;
        }
        const p = payloads[i];
        const refs: unknown[] = [
            p.cardId,
            (p.a as Record<string, unknown> | undefined)?.cardId,
            (p.b as Record<string, unknown> | undefined)?.cardId,
        ];
        for (const id of refs) {
            if (typeof id === "number" && id > 0 && !existingIds.has(id)) {
                return err("not_found", i, `referenced card ${id} is not on this board`);
            }
        }
    }

    // 7) Origin for a section/journey target: inside the frame, below existing members.
    let origin: { x: number; y: number } | null = null;
    if (targetFrame) {
        const ox = targetFrame.x + SECTION_PAD_X;
        let oy = targetFrame.y + SECTION_PAD_TOP;
        if (targetFrame.id !== undefined) {
            for (const m of existing) {
                if (m.kind === "section" || containingSection(frames, m)?.id !== targetFrame.id) {
                    continue;
                }
                const h = m.h > 0 ? m.h : ZERO_H;
                if (m.y + h + COMPOSE_GAP > oy) {
                    oy = m.y + h + COMPOSE_GAP;
                }
            }
        }
        origin = { x: ox, y: oy };
    }

    const region = composePlace({
        cards: placed,
        existing,
        anchor,
        origin,
        mode: body.layout ?? "",
        withQuestion,
        childParent,
    });

    // 8) ONE transaction: adopt/create journey frame, insert cards + edges + questions, grow section.
    const now = nowIso();
    const written = await db.kysely.transaction().execute(async (trx) => {
        let elemSeq = board.elem_seq;
        let createdSection: CardDto | null = null;

        if (adopt) {
            const secRow = await trx
                .selectFrom("board_cards")
                .select("payload")
                .where("id", "=", adopt.sectionId)
                .executeTakeFirst();
            const merged = {
                ...(SafeJSON.parse(secRow?.payload || "{}", { strict: true }) as Record<string, unknown>),
                journey: adopt.journey,
                pass: 1,
            };
            await trx
                .updateTable("board_cards")
                .set({ payload: SafeJSON.stringify(merged), updated_at: now })
                .where("id", "=", adopt.sectionId)
                .execute();
        }
        if (createFrame) {
            elemSeq += 1;
            const secInserted = await trx
                .insertInto("board_cards")
                .values({
                    board_id: board.id,
                    kind: "section",
                    x: createFrame.x,
                    y: createFrame.y,
                    w: createFrame.w,
                    h: createFrame.h,
                    z: -2,
                    set_ref: "",
                    set_version: 0,
                    file_path: "",
                    blob_key: "",
                    payload: SafeJSON.stringify(createFrame.payload),
                    created_by: actor,
                    elem_no: elemSeq,
                    current_version: 1,
                    deleted_at: "",
                    created_at: now,
                    updated_at: now,
                })
                .returningAll()
                .executeTakeFirstOrThrow();
            createdSection = toCardDto(secInserted);
            targetFrame = {
                id: secInserted.id,
                x: createFrame.x,
                y: createFrame.y,
                w: createFrame.w,
                h: createFrame.h,
            };
        }

        const createdCards: CardDto[] = [];
        for (let i = 0; i < placed.length; i += 1) {
            elemSeq += 1;
            const z = placed[i].kind === "cluster" ? -1 : placed[i].kind === "section" ? -2 : 0;
            const inserted = await trx
                .insertInto("board_cards")
                .values({
                    board_id: board.id,
                    kind: placed[i].kind,
                    x: placed[i].x,
                    y: placed[i].y,
                    w: placed[i].w,
                    h: placed[i].h,
                    z,
                    set_ref: "",
                    set_version: 0,
                    file_path: "",
                    blob_key: "",
                    payload: SafeJSON.stringify(payloads[i]),
                    created_by: actor,
                    elem_no: elemSeq,
                    current_version: 1,
                    deleted_at: "",
                    created_at: now,
                    updated_at: now,
                })
                .returningAll()
                .executeTakeFirstOrThrow();
            createdCards.push(toCardDto(inserted));
        }

        await trx
            .updateTable("boards")
            .set({ elem_seq: elemSeq, updated_at: now })
            .where("id", "=", board.id)
            .execute();

        const createdEdges: EdgeDto[] = [];
        for (const e of edgeResolved) {
            const fromCard = e.fromIdx >= 0 ? createdCards[e.fromIdx].id : e.fromId;
            const toCard = e.toIdx >= 0 ? createdCards[e.toIdx].id : e.toId;
            const inserted = await trx
                .insertInto("board_edges")
                .values({
                    board_id: board.id,
                    from_card: fromCard,
                    to_card: toCard,
                    to_x: 0,
                    to_y: 0,
                    label: e.label,
                    created_by: actor,
                    created_at: now,
                })
                .returningAll()
                .executeTakeFirstOrThrow();
            createdEdges.push({
                id: inserted.id,
                boardId: inserted.board_id,
                fromCard: inserted.from_card,
                toCard: inserted.to_card === 0 ? null : inserted.to_card,
                toX: inserted.to_x,
                toY: inserted.to_y,
                label: inserted.label,
            });
        }

        const createdQuestions: QuestionDto[] = [];
        for (const q of questionResolved) {
            const cardId = q.cardIdx >= 0 ? createdCards[q.cardIdx].id : q.cardId;
            const inserted = await trx
                .insertInto("board_questions")
                .values({
                    board_id: board.id,
                    card_id: cardId,
                    prompt: q.prompt,
                    options: q.options,
                    answer: "",
                    answered_by: "",
                    delivered: 0,
                    staged: 1,
                    multi: q.multi ? 1 : 0,
                    created_at: now,
                    answered_at: "",
                })
                .returningAll()
                .executeTakeFirstOrThrow();
            createdQuestions.push({
                id: inserted.id,
                boardId: inserted.board_id,
                cardId: inserted.card_id === 0 ? null : inserted.card_id,
                prompt: inserted.prompt,
                options: SafeJSON.parse(inserted.options || "[]", { strict: true }) as QuestionDto["options"],
                answer: inserted.answer ? (SafeJSON.parse(inserted.answer, { strict: true }) as string[]) : null,
                answeredBy: inserted.answered_by,
                staged: inserted.staged === 1,
                multi: inserted.multi === 1,
                createdAt: inserted.created_at,
                answeredAt: inserted.answered_at,
            });
        }

        // Grow the targeted section to fit what just landed (+ padding).
        if (targetFrame?.id !== undefined) {
            const needW = region.x + region.w + SECTION_PAD_X - targetFrame.x;
            const needH = region.y + region.h + SECTION_PAD_BOT - targetFrame.y;
            if (needW > targetFrame.w || needH > targetFrame.h) {
                const nw = Math.max(needW, targetFrame.w);
                const nh = Math.max(needH, targetFrame.h);
                await trx
                    .updateTable("board_cards")
                    .set({ w: nw, h: nh, updated_at: now })
                    .where("id", "=", targetFrame.id)
                    .execute();
            }
        }

        return { createdCards, createdEdges, createdQuestions, createdSection };
    });

    const cardsOut = written.createdCards.map((c, i) => ({
        id: c.id,
        elemNo: c.elemNo,
        ...(cardsIn[i].ref ? { ref: cardsIn[i].ref } : {}),
    }));

    notifyLayoutChanged(db, slug);

    return {
        ok: true,
        cards: cardsOut,
        edges: written.createdEdges.map((e) => e.id),
        questions: written.createdQuestions.map((q) => q.id),
        region,
        events: {
            // A freshly-created journey section rides the same bulk cards event so the UI sees it.
            cards: written.createdSection ? [written.createdSection, ...written.createdCards] : written.createdCards,
            edges: written.createdEdges,
            questions: written.createdQuestions,
            boardId: board.id,
        },
    };
}

const UPDATE_MAX_OPS = 100;

export interface UpdateCardsBody {
    patch?: Array<{
        id: number;
        x?: number;
        y?: number;
        w?: number;
        h?: number;
        z?: number;
        payload?: Record<string, unknown>;
    }>;
    remove?: number[];
    restore?: number[];
}

export type UpdateCardsResult =
    | { ok: true; patched: number; removed: number; restored: number; events: { cards: CardDto[]; deleted: number[] } }
    | { ok: false; code: ComposeErrorCode; index: number; message: string };

/** Batch edit of the agent's OWN layer: patch geometry/payload, soft-remove, and restore — every op
 *  restricted to payload.layer === "ai" cards (sections count, being shared journey structure).
 *  Mirrors handlers_compose.go:1221-1372. Validated as a whole, then applied per-op (GT's helpers
 *  are self-transacting and can't nest — same shape as vitrinka's per-op application). */
export async function updateCards(
    db: DatabaseClient<BoardsDb>,
    slug: string,
    body: UpdateCardsBody
): Promise<UpdateCardsResult> {
    const patch = body.patch ?? [];
    const remove = body.remove ?? [];
    const restore = body.restore ?? [];
    const n = patch.length + remove.length + restore.length;
    if (n === 0) {
        return err("empty", -1, "patch+remove+restore: at least 1 entry required") as UpdateCardsResult;
    }
    if (n > UPDATE_MAX_OPS) {
        return err("limit", -1, `patch+remove+restore: at most ${UPDATE_MAX_OPS} entries`) as UpdateCardsResult;
    }

    const doc = await getBoardDoc(db, slug); // throws NotFoundError → route maps to 404
    const aiCards = new Set<number>();
    const sectionCards = new Set<number>();
    const kindById = new Map<number, string>();
    for (const c of doc.cards) {
        kindById.set(c.id, c.kind);
        if (c.kind === "section") {
            aiCards.add(c.id);
            sectionCards.add(c.id);
        } else if (c.payload.layer === "ai") {
            aiCards.add(c.id);
        }
    }

    // Validate everything first (all-or-nothing).
    for (let i = 0; i < patch.length; i += 1) {
        if (!aiCards.has(patch[i].id)) {
            return err("not_ai_layer", i, `card ${patch[i].id} is not on the AI layer`) as UpdateCardsResult;
        }
    }
    for (let i = 0; i < remove.length; i += 1) {
        if (!aiCards.has(remove[i])) {
            return err("not_ai_layer", i, `card ${remove[i]} is not on the AI layer`) as UpdateCardsResult;
        }
    }
    if (restore.length > 0) {
        // Removals are SOFT (trash) — restore is validated against the board's TRASH, not its live cards.
        const trash = await listTrash(db, slug);
        const trashAI = new Set<number>();
        for (const c of trash) {
            if (c.kind === "section" || c.payload.layer === "ai") {
                trashAI.add(c.id);
            }
        }
        for (let i = 0; i < restore.length; i += 1) {
            if (!trashAI.has(restore[i])) {
                return err(
                    "not_ai_layer",
                    i,
                    `card ${restore[i]} is not an AI-layer card in this board's trash`
                ) as UpdateCardsResult;
            }
        }
    }

    const cardEvents: CardDto[] = [];
    const deleted: number[] = [];
    for (const p of patch) {
        const kind = (kindById.get(p.id) ?? "text") as ComposeKind;
        const card = await patchCard(db, p.id, {
            x: p.x,
            y: p.y,
            w: p.w,
            h: p.h,
            z: p.z,
            // Re-stamp layer:ai (agent can't unstamp itself by omitting it); sections stay neutral.
            payload: p.payload !== undefined ? stampLayer(kind, p.payload) : undefined,
        });
        cardEvents.push(card);
    }
    for (const id of remove) {
        await softDeleteCard(db, id);
        deleted.push(id);
    }
    for (const id of restore) {
        cardEvents.push(await restoreCard(db, id));
    }

    notifyLayoutChanged(db, slug);
    return {
        ok: true,
        patched: patch.length,
        removed: remove.length,
        restored: restore.length,
        events: { cards: cardEvents, deleted },
    };
}
