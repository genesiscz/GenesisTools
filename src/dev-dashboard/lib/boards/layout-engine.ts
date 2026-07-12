// Layout engine (vitrinka internal/web/autolayout.go + handlers_compose.go:770-1212): the 12
// selection arrange modes (+ compare, a two-section verb), section growth/displacement, and the
// debounced saved-layout reflow. The pure geometry is testable in isolation; DB writes go through
// bulkLayout and SSE publishes after the writes commit.

import { logger } from "@app/logger";
import type { DatabaseClient } from "@app/utils/database/client";
import { SafeJSON } from "@app/utils/json";
import { bulkLayout, toCardDto } from "./boards-store";
import {
    type ArrangeMode,
    COMPOSE_GAP,
    COMPOSE_GRID,
    DEFAULT_WRAP_W,
    SECTION_PAD_BOT,
    SECTION_PAD_TOP,
    SECTION_PAD_X,
    SPACING,
} from "./compose-types";
import type { BoardsDb } from "./db-types";
import { publishBoardEvent } from "./events";
import { containingSection, type SectionCard, sectionByName, sectionFrames } from "./sections";
import type { CardDto } from "./types";

// ---- pure geometry ----

/** Richer than CardDto: carries created_at, file_path and parsed payload that layout modes need. */
export interface CardRect {
    id: number;
    kind: string;
    x: number;
    y: number;
    w: number;
    h: number;
    createdAt?: string;
    filePath?: string;
    payload: Record<string, unknown>;
}

export interface Move {
    id: number;
    x: number;
    y: number;
    w?: number;
    h?: number;
}

export interface ArrangeOpts {
    mode: ArrangeMode;
    gap: number;
    cols?: number;
    origin?: { x: number; y: number };
    wrapW?: number;
}

const DEFAULT_W = 340;
const DEFAULT_H = 220;
const DISPLACE_GUTTER = 80;
const LANE_GUTTER_FACTOR = 1.6;

function wOf(c: { w: number }): number {
    return c.w > 0 ? c.w : DEFAULT_W;
}
function hOf(c: { h: number }): number {
    return c.h > 0 ? c.h : DEFAULT_H;
}

/** Parse a gap/padding token: absent → default; "S"|"M"|"L" → 12|24|48; number 0-400 → itself;
 *  anything else → null (the caller 400s). */
export function spacingToken(raw: unknown, def: number): number | null {
    if (raw === undefined || raw === null) {
        return def;
    }
    if (typeof raw === "string") {
        const up = raw.trim().toUpperCase();
        if (up === "S") {
            return SPACING.S;
        }
        if (up === "M") {
            return SPACING.M;
        }
        if (up === "L") {
            return SPACING.L;
        }
        return null;
    }
    if (typeof raw === "number" && raw >= 0 && raw <= 400) {
        return raw;
    }
    return null;
}

/** Banded-Y reading order (16px quanta, then x): a few-pixel jiggle never reorders a row. */
export function readingOrder<T extends { x: number; y: number }>(cards: T[]): T[] {
    return cards.slice().sort((a, b) => {
        const ba = Math.round(a.y / 16);
        const bb = Math.round(b.y / 16);
        return ba !== bb ? ba - bb : a.x - b.x;
    });
}

function creationCmp(a: CardRect, b: CardRect): number {
    const ca = a.createdAt ?? "";
    const cb = b.createdAt ?? "";
    if (ca !== cb) {
        return ca < cb ? -1 : 1;
    }
    return a.id - b.id;
}

/** Compute new positions for one selection arrange mode (compare is handled separately). */
export function arrangeMoves(sel: CardRect[], opts: ArrangeOpts): Move[] {
    const gap = opts.gap > 0 ? opts.gap : COMPOSE_GAP;
    const gs = sel.map((c) => ({ c, w: wOf(c), h: hOf(c) }));

    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    for (const g of gs) {
        minX = Math.min(minX, g.c.x);
        minY = Math.min(minY, g.c.y);
    }
    if (opts.origin) {
        minX = opts.origin.x;
        minY = opts.origin.y;
    } else {
        minX = Math.round(minX / COMPOSE_GRID) * COMPOSE_GRID;
        minY = Math.round(minY / COMPOSE_GRID) * COMPOSE_GRID;
    }

    // Reading order with banded y (Array.sort is stable in bun/V8).
    gs.sort((a, b) => {
        const ba = Math.round(a.c.y / 16);
        const bb = Math.round(b.c.y / 16);
        return ba !== bb ? ba - bb : a.c.x - b.c.x;
    });

    const moves: Move[] = [];
    const snap = (v: number): number => Math.round(v);

    switch (opts.mode) {
        case "align-left":
            for (const g of gs) {
                moves.push({ id: g.c.id, x: snap(minX), y: snap(g.c.y) });
            }
            break;
        case "align-top":
            for (const g of gs) {
                moves.push({ id: g.c.id, x: snap(g.c.x), y: snap(minY) });
            }
            break;
        case "distribute-h": {
            gs.sort((a, b) => a.c.x - b.c.x);
            let x = minX;
            for (const g of gs) {
                moves.push({ id: g.c.id, x: snap(x), y: snap(g.c.y) });
                x += g.w + gap;
            }
            break;
        }
        case "distribute-v": {
            gs.sort((a, b) => a.c.y - b.c.y);
            let y = minY;
            for (const g of gs) {
                moves.push({ id: g.c.id, x: snap(g.c.x), y: snap(y) });
                y += g.h + gap;
            }
            break;
        }
        case "masonry": {
            gs.sort((a, b) => creationCmp(a.c, b.c));
            const cols = opts.cols && opts.cols > 0 ? opts.cols : 3;
            let colW = 0;
            for (const g of gs) {
                colW = Math.max(colW, g.w);
            }
            const heights = new Array(cols).fill(0);
            for (const g of gs) {
                let c = 0;
                for (let k = 1; k < cols; k += 1) {
                    if (heights[k] < heights[c]) {
                        c = k;
                    }
                }
                moves.push({ id: g.c.id, x: snap(minX + c * (colW + gap)), y: snap(minY + heights[c]) });
                heights[c] += g.h + gap;
            }
            break;
        }
        case "timeline": {
            gs.sort((a, b) => creationCmp(a.c, b.c));
            let x = minX;
            for (const g of gs) {
                moves.push({ id: g.c.id, x: snap(x), y: snap(minY) });
                x += g.w + gap;
            }
            break;
        }
        case "timeaxis": {
            gs.sort((a, b) => creationCmp(a.c, b.c));
            let packedW = 0;
            for (const g of gs) {
                packedW += g.w + gap;
            }
            packedW -= gap;
            const axisW = Math.max(opts.wrapW ?? 0, packedW);
            const getTime = (d: string | undefined) => {
                const t = d ? Date.parse(d) : 0;
                return Number.isNaN(t) ? 0 : t;
            };
            const t0 = getTime(gs[0].c.createdAt);
            const span = (getTime(gs[gs.length - 1].c.createdAt) - t0) / 1000;
            let x = minX;
            for (const g of gs) {
                let gx = x;
                if (span > 0) {
                    const t = getTime(g.c.createdAt);
                    const frac = (t - t0) / 1000 / span;
                    gx = Math.max(x, minX + frac * (axisW - g.w));
                }
                moves.push({ id: g.c.id, x: snap(gx), y: snap(minY) });
                x = gx + g.w + gap;
            }
            break;
        }
        case "lanes": {
            gs.sort((a, b) => creationCmp(a.c, b.c));
            const laneOf = (c: CardRect): string => (typeof c.payload.lane === "string" ? c.payload.lane : "");
            const laneOrder: string[] = [];
            const lanes = new Map<string, Array<(typeof gs)[number]>>();
            for (const g of gs) {
                const k = laneOf(g.c);
                if (!lanes.has(k)) {
                    laneOrder.push(k);
                    lanes.set(k, []);
                }
                lanes.get(k)?.push(g);
            }
            laneOrder.sort((a, b) => (a !== "" && b === "" ? -1 : 0)); // unlabeled lane reads last (stable)
            let y = minY;
            for (const k of laneOrder) {
                let x = minX;
                let rowH = 0;
                for (const g of lanes.get(k) ?? []) {
                    moves.push({ id: g.c.id, x: snap(x), y: snap(y) });
                    rowH = Math.max(rowH, g.h);
                    x += g.w + gap;
                }
                y += rowH + gap * LANE_GUTTER_FACTOR;
            }
            break;
        }
        case "flow": {
            const wrapW = opts.wrapW && opts.wrapW > 0 ? opts.wrapW : DEFAULT_WRAP_W;
            let x = minX;
            let y = minY;
            let rowH = 0;
            for (const g of gs) {
                if (x > minX && x + g.w > minX + wrapW) {
                    x = minX;
                    y += rowH + gap;
                    rowH = 0;
                }
                moves.push({ id: g.c.id, x: snap(x), y: snap(y) });
                rowH = Math.max(rowH, g.h);
                x += g.w + gap;
            }
            break;
        }
        default: {
            // column | row | grid
            let perRow = 1;
            if (opts.mode === "row") {
                perRow = gs.length;
            } else if (opts.mode === "grid") {
                perRow = opts.cols && opts.cols > 0 ? opts.cols : 3;
            }
            if (perRow < 1) {
                perRow = 1;
            }
            let x = minX;
            let y = minY;
            let rowH = 0;
            gs.forEach((g, i) => {
                if (i > 0 && i % perRow === 0) {
                    x = minX;
                    y += rowH + gap;
                    rowH = 0;
                }
                moves.push({ id: g.c.id, x: snap(x), y: snap(y) });
                rowH = Math.max(rowH, g.h);
                x += g.w + gap;
            });
        }
    }
    return moves;
}

/** Modes a section may persist for auto-reflow (compare is excluded — it's a manual verb). */
export const AUTO_LAYOUT_MODES: ReadonlySet<string> = new Set([
    "grid",
    "column",
    "row",
    "flow",
    "lanes",
    "masonry",
    "timeline",
    "timeaxis",
]);

interface LayoutSpec {
    mode: ArrangeMode;
    gap: number;
    cols: number;
    pad: number;
}

/** Parse a section card's persisted payload.layout; null = a manual section (no auto-reflow). */
export function sectionLayoutSpec(card: SectionCard): LayoutSpec | null {
    const layout = card.payload.layout;
    if (typeof layout !== "object" || layout === null) {
        return null;
    }
    const l = layout as Record<string, unknown>;
    const mode = typeof l.mode === "string" ? l.mode : "";
    if (!AUTO_LAYOUT_MODES.has(mode)) {
        return null;
    }
    const gap = spacingToken(l.gap, COMPOSE_GAP) ?? COMPOSE_GAP;
    const pad = spacingToken(l.padding, SECTION_PAD_X) ?? SECTION_PAD_X;
    return { mode: mode as ArrangeMode, gap, cols: typeof l.cols === "number" ? l.cols : 0, pad };
}

// ---- impure: load, membership, displacement, compare, reflow ----

function rowToRect(r: {
    id: number;
    kind: string;
    x: number;
    y: number;
    w: number;
    h: number;
    created_at: string;
    file_path: string;
    payload: string;
}): CardRect {
    return {
        id: r.id,
        kind: r.kind,
        x: r.x,
        y: r.y,
        w: r.w,
        h: r.h,
        createdAt: r.created_at,
        filePath: r.file_path,
        payload: SafeJSON.parse(r.payload || "{}", { strict: true }) as Record<string, unknown>,
    };
}

async function loadCards(db: DatabaseClient<BoardsDb>, slug: string): Promise<CardRect[] | null> {
    const board = await db.kysely.selectFrom("boards").select(["id"]).where("slug", "=", slug).executeTakeFirst();
    if (!board) {
        return null;
    }
    const rows = await db.kysely
        .selectFrom("board_cards")
        .selectAll()
        .where("board_id", "=", board.id)
        .where("deleted_at", "=", "")
        .execute();
    return rows.map(rowToRect);
}

/** Snapshot spatial membership as plain ids, taken BEFORE geometry mutates. */
export function memberIdsBySection(cards: CardRect[]): Map<number, number[]> {
    const frames = sectionFrames(cards);
    const out = new Map<number, number[]>();
    for (const c of cards) {
        if (c.kind === "section") {
            continue;
        }
        const owner = containingSection(frames, c);
        if (owner) {
            out.set(owner.id, [...(out.get(owner.id) ?? []), c.id]);
        }
    }
    return out;
}

/** Resolve frame overlaps after growth: a later-reading section overlapped by an earlier one shifts
 *  DOWN below it (+gutter) with its pre-op members. Bounded 4-iteration cascade. Returns the moves. */
async function displaceSections(
    db: DatabaseClient<BoardsDb>,
    slug: string,
    cards: CardRect[],
    memberIds: Map<number, number[]>
): Promise<Move[]> {
    const pos = new Map<number, CardRect>();
    for (const c of cards) {
        pos.set(c.id, { ...c });
    }
    const secs = sectionFrames(Array.from(pos.values()));
    if (secs.length < 2) {
        return [];
    }
    const shifted = new Set<number>();
    for (let iter = 0; iter < 4; iter += 1) {
        let moved = false;
        for (let i = 0; i < secs.length; i += 1) {
            const cur = pos.get(secs[i].id);
            if (!cur) {
                continue;
            }
            const cw = wOf(cur);
            const ch = hOf(cur);
            for (let j = 0; j < i; j += 1) {
                const p = pos.get(secs[j].id);
                if (!p) {
                    continue;
                }
                const pw = wOf(p);
                const ph = hOf(p);
                if (cur.x >= p.x + pw || p.x >= cur.x + cw || cur.y >= p.y + ph || p.y >= cur.y + ch) {
                    continue; // no overlap
                }
                const dy = p.y + ph + DISPLACE_GUTTER - cur.y;
                if (dy <= 0) {
                    continue;
                }
                cur.y += dy;
                for (const mid of memberIds.get(cur.id) ?? []) {
                    const m = pos.get(mid);
                    if (m) {
                        m.y += dy;
                    }
                }
                shifted.add(cur.id);
                moved = true;
            }
        }
        if (!moved) {
            break;
        }
    }
    if (shifted.size === 0) {
        return [];
    }
    const moves: Move[] = [];
    for (const id of shifted) {
        for (const cid of [id, ...(memberIds.get(id) ?? [])]) {
            const c = pos.get(cid);
            if (c) {
                moves.push({ id: c.id, x: c.x, y: c.y, w: wOf(c), h: hOf(c) });
            }
        }
    }
    if (moves.length > 0) {
        await bulkLayout(db, slug, moves);
    }
    return moves;
}

// ---- compare (two sections side-by-side) ----

function baseName(filePath: string | undefined): string {
    if (!filePath) {
        return "";
    }
    const i = filePath.lastIndexOf("/");
    return (i >= 0 ? filePath.slice(i + 1) : filePath).toLowerCase();
}

/** Pair iteration counterparts: same screenshot basename first, remaining by index order. */
export function pairSectionMembers(as: CardRect[], bs: CardRect[]): Array<{ a?: CardRect; b?: CardRect }> {
    const usedB = new Array(bs.length).fill(false);
    const byName = new Map<string, number>();
    bs.forEach((c, j) => {
        const k = baseName(c.filePath);
        if (k && !byName.has(k)) {
            byName.set(k, j);
        }
    });
    const pairs: Array<{ a?: CardRect; b?: CardRect }> = [];
    for (const a of as) {
        const k = baseName(a.filePath);
        const j = k ? byName.get(k) : undefined;
        if (j !== undefined && !usedB[j]) {
            usedB[j] = true;
            pairs.push({ a, b: bs[j] });
        } else {
            pairs.push({ a });
        }
    }
    let bi = 0;
    for (const pair of pairs) {
        if (pair.b) {
            continue;
        }
        while (bi < bs.length && usedB[bi]) {
            bi += 1;
        }
        if (bi < bs.length) {
            usedB[bi] = true;
            pair.b = bs[bi];
        }
    }
    bs.forEach((c, j) => {
        if (!usedB[j]) {
            pairs.push({ b: c });
        }
    });
    return pairs;
}

interface ArrangeOutcome {
    ok: boolean;
    status: number;
    message?: string;
    moved: number;
    cards: Move[];
    saved: boolean;
}

async function arrangeCompare(
    db: DatabaseClient<BoardsDb>,
    slug: string,
    cards: CardRect[],
    names: string[],
    gap: number,
    pad: number
): Promise<ArrangeOutcome> {
    if (names.length !== 2) {
        return {
            ok: false,
            status: 400,
            message: 'mode "compare" needs sections: ["A", "B"]',
            moved: 0,
            cards: [],
            saved: false,
        };
    }
    const frames = sectionFrames(cards);
    const sa = sectionByName(frames, names[0]);
    const sb = sectionByName(frames, names[1]);
    if (!sa || !sb) {
        return { ok: false, status: 404, message: "no such section on this board", moved: 0, cards: [], saved: false };
    }
    if (sa.id === sb.id) {
        return {
            ok: false,
            status: 400,
            message: "compare needs two different sections",
            moved: 0,
            cards: [],
            saved: false,
        };
    }
    const membersOf = (name: string): CardRect[] =>
        cards.filter(
            (c) => c.kind !== "section" && containingSection(frames, c)?.id === sectionByName(frames, name)?.id
        );
    const ma = membersOf(names[0]);
    const mb = membersOf(names[1]);
    if (ma.length === 0 && mb.length === 0) {
        return {
            ok: false,
            status: 400,
            message: "nothing to compare: both sections are empty",
            moved: 0,
            cards: [],
            saved: false,
        };
    }
    const colW = (ms: CardRect[]): number => ms.reduce((w, m) => Math.max(w, m.w), 340);
    const wa = colW(ma);
    const wb = colW(mb);
    const padTop = Math.max(pad, SECTION_PAD_TOP);
    const nbx = sa.x + wa + 2 * pad + DISPLACE_GUTTER;
    const nby = sa.y;
    const aox = sa.x + pad;
    const box = nbx + pad;
    let y = sa.y + padTop;
    const moves: Move[] = [];
    for (const p of pairSectionMembers(ma, mb)) {
        let rowH = 0;
        if (p.a) {
            rowH = Math.max(rowH, hOf(p.a));
            moves.push({ id: p.a.id, x: aox, y });
        }
        if (p.b) {
            rowH = Math.max(rowH, hOf(p.b));
            moves.push({ id: p.b.id, x: box, y });
        }
        y += rowH + gap;
    }
    const frameBottom = y - gap + SECTION_PAD_BOT;
    // Grow/move both frames (resize via bulkLayout w/h) + move B beside A.
    moves.push({ id: sa.id, x: sa.x, y: sa.y, w: wa + 2 * pad, h: frameBottom - sa.y });
    moves.push({ id: sb.id, x: nbx, y: nby, w: wb + 2 * pad, h: frameBottom - nby });
    await bulkLayout(db, slug, moves);

    // Compare is MANUAL: strip any saved auto-layout from both sections so reflow won't undo it.
    for (const sec of [sa, sb]) {
        if (sec.payload.layout !== undefined) {
            const merged = { ...sec.payload };
            delete merged.layout;
            await db.kysely
                .updateTable("board_cards")
                .set({ payload: SafeJSON.stringify(merged) })
                .where("id", "=", sec.id)
                .execute();
        }
    }
    const displaceMoves = await displaceSections(db, slug, cards, memberIdsBySection(cards));
    const all = [...moves, ...displaceMoves];
    publishBoardEvent(slug, { type: "layout", payload: { moves: all } });
    return { ok: true, status: 200, moved: all.length, cards: all, saved: false };
}

// ---- arrange orchestrator (the route calls this) ----

export interface ArrangeBody {
    mode: string;
    scope?: string;
    ids?: number[];
    gap?: unknown;
    padding?: unknown;
    cols?: number;
    sizing?: string;
    save?: boolean;
    sections?: string[];
}

const ARRANGE_MODES: ReadonlySet<string> = new Set([
    "column",
    "row",
    "grid",
    "flow",
    "lanes",
    "masonry",
    "timeline",
    "timeaxis",
    "compare",
    "align-left",
    "align-top",
    "distribute-h",
    "distribute-v",
]);

/** Broad-scope arrange treats each section + its spatial members as ONE unit (the frame is the unit's
 *  bounding box): arranging moves the frame and applies the same delta to every member, so members
 *  never scatter out of their frame and their in-frame layout is preserved. Loose cards (no containing
 *  section) arrange as individual units alongside. Returns null when no section is in scope, so the
 *  caller falls back to the per-card path. */
async function arrangeComposite(
    db: DatabaseClient<BoardsDb>,
    slug: string,
    all: CardRect[],
    frames: SectionCard[],
    body: ArrangeBody,
    gap: number
): Promise<ArrangeOutcome | null> {
    const memberIds = memberIdsBySection(all);
    const allById = new Map(all.map((c) => [c.id, c]));

    let seed: (c: CardRect) => boolean;
    let allFrames = false;
    if (body.ids && body.ids.length > 0) {
        const want = new Set(body.ids);
        seed = (c) => want.has(c.id);
    } else if (body.scope === "all") {
        seed = () => true;
        allFrames = true;
    } else {
        seed = (c) => c.payload.layer === "ai";
    }

    // Section units: every in-scope frame carries ALL its spatial members (container semantics).
    const unitFrames: CardRect[] = [];
    for (const f of frames) {
        const frame = allById.get(f.id);
        if (!frame) {
            continue;
        }

        const mids = memberIds.get(f.id) ?? [];
        const touched =
            allFrames ||
            seed(frame) ||
            mids.some((id) => {
                const m = allById.get(id);
                return m ? seed(m) : false;
            });
        if (touched) {
            unitFrames.push(frame);
        }
    }
    if (unitFrames.length === 0) {
        return null; // no section involvement → let the per-card path handle it
    }

    // Loose units: in-scope non-section cards with no containing section.
    const looseCards: CardRect[] = [];
    for (const c of all) {
        if (c.kind === "section" || !seed(c)) {
            continue;
        }
        if (containingSection(frames, c)) {
            continue;
        }

        looseCards.push(c);
    }

    // One pseudo-rect per unit (section units use the frame's own bbox); each maps to the card ids
    // that travel with it (frame + members, or the lone loose card).
    const rects: CardRect[] = [];
    const carry = new Map<number, number[]>();
    for (const f of unitFrames) {
        rects.push(f);
        carry.set(f.id, [f.id, ...(memberIds.get(f.id) ?? [])]);
    }
    for (const c of looseCards) {
        rects.push(c);
        carry.set(c.id, [c.id]);
    }
    if (rects.length < 2) {
        // A single unit: nothing to rearrange at the top level (members keep their in-frame layout).
        return { ok: true, status: 200, moved: 0, cards: [], saved: false };
    }

    const opts: ArrangeOpts = { mode: body.mode as ArrangeMode, gap, cols: body.cols };
    const unitMoves = arrangeMoves(rects, opts);
    const rectById = new Map(rects.map((r) => [r.id, r]));

    // Expand each unit move into per-card moves via the unit's delta (preserving in-frame offsets).
    const writeMoves: Move[] = [];
    for (const um of unitMoves) {
        const rect = rectById.get(um.id);
        if (!rect) {
            continue;
        }

        const dx = um.x - rect.x;
        const dy = um.y - rect.y;
        for (const cid of carry.get(um.id) ?? []) {
            const c = allById.get(cid);
            if (!c) {
                continue;
            }

            writeMoves.push({ id: c.id, x: c.x + dx, y: c.y + dy, w: wOf(c), h: hOf(c) });
        }
    }
    if (writeMoves.length === 0) {
        return { ok: true, status: 200, moved: 0, cards: [], saved: false };
    }

    await bulkLayout(db, slug, writeMoves);
    publishBoardEvent(slug, { type: "layout", payload: { moves: writeMoves } });
    return { ok: true, status: 200, moved: writeMoves.length, cards: writeMoves, saved: false };
}

export async function runArrange(
    db: DatabaseClient<BoardsDb>,
    slug: string,
    body: ArrangeBody
): Promise<ArrangeOutcome> {
    const fail = (status: number, message: string): ArrangeOutcome => ({
        ok: false,
        status,
        message,
        moved: 0,
        cards: [],
        saved: false,
    });
    if (!ARRANGE_MODES.has(body.mode)) {
        return fail(400, "mode: column|row|grid|flow|lanes|masonry|timeline|timeaxis|compare|align-*|distribute-*");
    }
    if (body.sizing && body.sizing !== "natural" && body.sizing !== "uniform") {
        return fail(400, "sizing: natural or uniform");
    }
    const gap = spacingToken(body.gap, COMPOSE_GAP);
    if (gap === null) {
        return fail(400, 'gap: "S", "M", "L" or 0-400 px');
    }
    const pad = spacingToken(body.padding, SECTION_PAD_X);
    if (pad === null) {
        return fail(400, 'padding: "S", "M", "L" or 0-400 px');
    }

    const all = await loadCards(db, slug);
    if (!all) {
        return fail(404, `board not found: ${slug}`);
    }

    if (body.mode === "compare") {
        return arrangeCompare(db, slug, all, body.sections ?? [], gap, pad);
    }

    const frames = sectionFrames(all);

    // Broad-scope arrange (all / ai / an id set that spans sections): sections are containers, so
    // arrange each section+members as ONE unit instead of scattering members across the board.
    if (!body.scope?.startsWith("section:") && frames.length > 0) {
        const composite = await arrangeComposite(db, slug, all, frames, body, gap);
        if (composite) {
            return composite;
        }
    }

    let sel: CardRect[];
    let sec: SectionCard | null = null;
    if (body.ids && body.ids.length > 0) {
        const want = new Set(body.ids);
        sel = all.filter((c) => want.has(c.id));
        if (sel.length !== body.ids.length) {
            return fail(404, "a card is not on this board");
        }
    } else if (body.scope?.startsWith("section:")) {
        const name = body.scope.slice("section:".length);
        sec = sectionByName(frames, name);
        if (!sec) {
            return fail(404, `no section named "${name}" on this board`);
        }
        sel = all.filter((c) => c.kind !== "section" && containingSection(frames, c)?.id === sec?.id);
    } else if (body.scope === "all") {
        sel = all.filter((c) => c.kind !== "section");
    } else {
        sel = all.filter((c) => c.payload.layer === "ai");
    }
    if (sel.length < 2) {
        return fail(400, "nothing to arrange: fewer than 2 cards in scope");
    }

    // Uniform sizing: every card takes the selection's max footprint before geometry runs.
    if (body.sizing === "uniform") {
        let maxW = 0;
        let maxH = 0;
        for (const c of sel) {
            maxW = Math.max(maxW, c.w);
            maxH = Math.max(maxH, c.h);
        }
        maxW = maxW > 0 ? maxW : DEFAULT_W;
        maxH = maxH > 0 ? maxH : DEFAULT_H;
        for (const c of sel) {
            if (c.w !== maxW || c.h !== maxH) {
                c.w = maxW;
                c.h = maxH;
            }
        }
    }

    const opts: ArrangeOpts = { mode: body.mode as ArrangeMode, gap, cols: body.cols };
    if (sec) {
        opts.origin = { x: sec.x + pad, y: sec.y + Math.max(pad, SECTION_PAD_TOP) };
        opts.wrapW = sec.w - 2 * pad;
    }
    const moves = arrangeMoves(sel, opts);
    // Merge uniform w/h into the moves so bulkLayout resizes in the same pass.
    const dimById = new Map(sel.map((c) => [c.id, { w: wOf(c), h: hOf(c) }]));
    const writeMoves: Move[] = moves.map((m) =>
        body.sizing === "uniform" ? { ...m, w: dimById.get(m.id)?.w, h: dimById.get(m.id)?.h } : m
    );
    await bulkLayout(db, slug, writeMoves);

    // Per-card ground truth + frame fit.
    const movesOut: Move[] = moves.map((m) => {
        const d = dimById.get(m.id) ?? { w: DEFAULT_W, h: DEFAULT_H };
        return { id: m.id, x: m.x, y: m.y, w: d.w, h: d.h };
    });
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (const m of movesOut) {
        maxX = Math.max(maxX, m.x + (m.w ?? DEFAULT_W));
        maxY = Math.max(maxY, m.y + (m.h ?? DEFAULT_H));
    }
    const cardEvents: CardDto[] = [];
    if (sec && moves.length > 0) {
        const needW = maxX + pad - sec.x;
        const needH = maxY + pad - sec.y;
        if (needW > sec.w || needH > sec.h) {
            const nw = Math.max(needW, sec.w);
            const nh = Math.max(needH, sec.h);
            await bulkLayout(db, slug, [{ id: sec.id, x: sec.x, y: sec.y, w: nw, h: nh }]);
            const grown = await reloadCard(db, sec.id);
            if (grown) {
                cardEvents.push(grown);
            }
        }
        movesOut.push(...(await displaceSections(db, slug, all, memberIdsBySection(all))));
    }

    // save: persist the layout onto the section so it self-maintains from now on.
    let saved = false;
    if (body.save) {
        if (!sec) {
            return fail(400, "save needs a section scope (scope: section:<Name>)");
        }
        if (!AUTO_LAYOUT_MODES.has(body.mode)) {
            return fail(400, "save supports self-maintaining modes only");
        }
        const layout: Record<string, unknown> = { mode: body.mode, gap, padding: pad };
        if (body.cols && body.cols > 0) {
            layout.cols = body.cols;
        }
        const merged = { ...sec.payload, layout };
        await db.kysely
            .updateTable("board_cards")
            .set({ payload: SafeJSON.stringify(merged) })
            .where("id", "=", sec.id)
            .execute();
        const updated = await reloadCard(db, sec.id);
        if (updated) {
            cardEvents.push(updated);
        }
        saved = true;
    }

    for (const c of cardEvents) {
        publishBoardEvent(slug, { type: "card", payload: c });
    }
    publishBoardEvent(slug, { type: "layout", payload: { moves: movesOut } });
    return { ok: true, status: 200, moved: moves.length, cards: movesOut, saved };
}

async function reloadCard(db: DatabaseClient<BoardsDb>, id: number): Promise<CardDto | null> {
    const row = await db.kysely.selectFrom("board_cards").selectAll().where("id", "=", id).executeTakeFirst();
    return row ? toCardDto(row) : null;
}

// ---- reflow (debounced saved-layout maintenance) ----

/** Solve every auto-layout section on the board, write only real changes, grow frames, displace
 *  neighbors, and publish ONE layout event. Returns the moves (for tests). */
export async function reflowBoard(db: DatabaseClient<BoardsDb>, slug: string): Promise<Move[]> {
    const cards = await loadCards(db, slug);
    if (!cards) {
        return [];
    }
    const frames = sectionFrames(cards);
    if (frames.length === 0) {
        return [];
    }
    const preMembers = memberIdsBySection(cards);
    const movesOut: Move[] = [];
    const cardEvents: CardDto[] = [];

    for (const frame of frames) {
        const spec = sectionLayoutSpec(frame);
        if (!spec) {
            continue;
        }
        const members = cards.filter((c) => c.kind !== "section" && containingSection(frames, c)?.id === frame.id);
        if (members.length === 0) {
            continue;
        }
        const opts: ArrangeOpts = {
            mode: spec.mode,
            gap: spec.gap,
            cols: spec.cols,
            origin: { x: frame.x + spec.pad, y: frame.y + Math.max(spec.pad, SECTION_PAD_TOP) },
            wrapW: frame.w - 2 * spec.pad,
        };
        const moves = arrangeMoves(members, opts);
        const dimById = new Map(members.map((m) => [m.id, { w: wOf(m), h: hOf(m) }]));
        const curById = new Map(members.map((m) => [m.id, { x: m.x, y: m.y }]));
        const changed: Move[] = [];
        let maxX = Number.NEGATIVE_INFINITY;
        let maxY = Number.NEGATIVE_INFINITY;
        for (const m of moves) {
            const d = dimById.get(m.id) ?? { w: DEFAULT_W, h: DEFAULT_H };
            maxX = Math.max(maxX, m.x + d.w);
            maxY = Math.max(maxY, m.y + d.h);
            const cur = curById.get(m.id);
            if (cur && Math.abs(cur.x - m.x) < 0.5 && Math.abs(cur.y - m.y) < 0.5) {
                continue; // no real change → zero writes, zero SSE
            }
            changed.push(m);
            movesOut.push({ id: m.id, x: m.x, y: m.y, w: d.w, h: d.h });
        }
        if (changed.length > 0) {
            await bulkLayout(db, slug, changed);
        }
        const needW = maxX + spec.pad - frame.x;
        const needH = maxY + spec.pad - frame.y;
        if (needW > frame.w + 0.5 || needH > frame.h + 0.5) {
            await bulkLayout(db, slug, [
                { id: frame.id, x: frame.x, y: frame.y, w: Math.max(needW, frame.w), h: Math.max(needH, frame.h) },
            ]);
            const grown = await reloadCard(db, frame.id);
            if (grown) {
                cardEvents.push(grown);
            }
        }
    }

    movesOut.push(...(await displaceSections(db, slug, cards, preMembers)));
    for (const c of cardEvents) {
        publishBoardEvent(slug, { type: "card", payload: c });
    }
    if (movesOut.length > 0) {
        publishBoardEvent(slug, { type: "layout", payload: { moves: movesOut } });
    }
    return movesOut;
}

// ---- debounced trigger ----

const REFLOW_DEBOUNCE_MS = 150;
const timers = new Map<string, ReturnType<typeof setTimeout>>();

/** Schedule a trailing-debounced reflow of the board's auto-layout sections. Call after any card
 *  geometry/membership change (compose, patch, delete, restore, upload, import). */
export function notifyLayoutChanged(db: DatabaseClient<BoardsDb>, slug: string): void {
    const existing = timers.get(slug);
    if (existing) {
        clearTimeout(existing);
    }
    const t = setTimeout(() => {
        timers.delete(slug);
        reflowBoard(db, slug).catch((err) => logger.debug({ err, slug }, "boards reflow failed"));
    }, REFLOW_DEBOUNCE_MS);
    if (typeof (t as { unref?: () => void }).unref === "function") {
        (t as { unref: () => void }).unref();
    }
    timers.set(slug, t);
}

/** Test-only: clear pending reflow timers so they don't fire against a torn-down db. */
export function __resetLayoutDebounce(): void {
    for (const t of timers.values()) {
        clearTimeout(t);
    }
    timers.clear();
}
