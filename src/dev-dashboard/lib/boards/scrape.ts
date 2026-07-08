// Board scrape digest (vitrinka handlers_capture.go:397-764): the whole board as ONE structured,
// token-cheap digest for the agent — media images, note/text/element digests, annotations, and the
// connect-tool edges walked into ordered journey chains. Pure over the loaded board doc.

import { SafeJSON } from "@app/utils/json";
import { blobUrl } from "./blobs";
import { pairSectionMembers } from "./layout-engine";
import { containingSection, type SectionCard, sectionByName, sectionFrames, sectionsToJSON } from "./sections";
import type { AnnotationDto, BoardDocDto, CardDto, EdgeDto } from "./types";

function scrapeTruncate(s: string): string {
    return s.length > 300 ? `${s.slice(0, 297)}…` : s;
}

function str(payload: Record<string, unknown>, key: string): string {
    return typeof payload[key] === "string" ? (payload[key] as string) : "";
}

/** One-line digest for a UI-core element (step/callout/checklist/compare/wireframe). */
function elementDigestLine(kind: string, payload: Record<string, unknown>): string {
    switch (kind) {
        case "step": {
            const st = str(payload, "status") || "todo";
            let line = `${str(payload, "title")} — ${st}`;
            const n = typeof payload.n === "number" ? payload.n : 0;
            if (n > 0) {
                line = `${n}. ${line}`;
            }
            if (str(payload, "note")) {
                line += ` · ${str(payload, "note")}`;
            }
            return scrapeTruncate(line);
        }
        case "callout":
            return scrapeTruncate(`${str(payload, "tone") || "info"}: ${str(payload, "md")}`);
        case "checklist": {
            const items = Array.isArray(payload.items) ? (payload.items as Array<Record<string, unknown>>) : [];
            const done = items.filter((it) => it.done === true).length;
            let line = `${done}/${items.length} done`;
            if (str(payload, "title")) {
                line += ` · ${str(payload, "title")}`;
            }
            const open = items
                .filter((it) => it.done !== true)
                .map((it) => (typeof it.text === "string" ? it.text : ""))
                .filter(Boolean);
            if (open.length > 0) {
                line += ` — open: ${open.join("; ")}`;
            }
            return scrapeTruncate(line);
        }
        case "compare": {
            const a = (payload.a as Record<string, unknown> | undefined)?.cardId ?? 0;
            const b = (payload.b as Record<string, unknown> | undefined)?.cardId ?? 0;
            return `compare card ${a} ↔ ${b} (${str(payload, "mode") || "wipe"})`;
        }
        case "wireframe": {
            const nodes = Array.isArray(payload.nodes) ? (payload.nodes as Array<Record<string, unknown>>) : [];
            let line = `wireframe (${str(payload, "device") || "phone"}): ${str(payload, "title")} — ${nodes.length} nodes`;
            const labeled = nodes.filter((n) => typeof n.label === "string" && n.label).map((n) => `${n.t}:${n.label}`);
            if (labeled.length > 0) {
                line += ` · ${labeled.join(", ")}`;
            }
            return scrapeTruncate(line);
        }
        default:
            return "";
    }
}

function cardText(kind: string, payload: Record<string, unknown>): string {
    switch (kind) {
        case "note":
            return str(payload, "text");
        case "text":
            return scrapeTruncate(str(payload, "md"));
        case "viz":
            return scrapeTruncate(
                `${str(payload, "viz")} ${str(payload, "title")} ${payload.data ? SafeJSON.stringify(payload.data) : ""}`.trim()
            );
        case "cluster":
            return str(payload, "title");
        case "step":
        case "callout":
        case "checklist":
        case "compare":
        case "wireframe":
            return elementDigestLine(kind, payload);
        default:
            return "";
    }
}

export interface ScrapeAnnotation {
    id: number;
    intent: string;
    status: string;
    prompt: string;
    by?: string;
}

export interface ScrapeCard {
    id: number;
    kind: string;
    ai: boolean;
    by?: string;
    section?: string;
    image?: string;
    text?: string;
    annotations?: ScrapeAnnotation[];
}

export type ScrapeResult = { ok: true; body: Record<string, unknown> } | { ok: false; status: number; message: string };

/** Turn card→card edges into ordered journey chains: roots (no incoming edge) walked DFS in reading
 *  order; point-anchored/dangling edges are not steps; cycle-trapped cards become singleton chains. */
function walkFlow(order: number[], pos: Map<number, { x: number; y: number }>, edges: EdgeDto[]): number[][] {
    const exists = new Set(order);
    const adj = new Map<number, number[]>();
    const indeg = new Map<number, number>();
    for (const e of edges) {
        if (e.toCard === null || e.toCard === 0 || !exists.has(e.fromCard) || !exists.has(e.toCard)) {
            continue;
        }
        adj.set(e.fromCard, [...(adj.get(e.fromCard) ?? []), e.toCard]);
        indeg.set(e.toCard, (indeg.get(e.toCard) ?? 0) + 1);
    }
    const roots = order.filter((id) => (indeg.get(id) ?? 0) === 0);
    roots.sort((a, b) => {
        const pa = pos.get(a) ?? { x: 0, y: 0 };
        const pb = pos.get(b) ?? { x: 0, y: 0 };
        return pa.y !== pb.y ? pa.y - pb.y : pa.x - pb.x;
    });
    const visited = new Set<number>();
    const chains: number[][] = [];
    for (const root of roots) {
        if (visited.has(root)) {
            continue;
        }
        const chain: number[] = [];
        const dfs = (id: number): void => {
            if (visited.has(id)) {
                return;
            }
            visited.add(id);
            chain.push(id);
            for (const nxt of adj.get(id) ?? []) {
                dfs(nxt);
            }
        };
        dfs(root);
        chains.push(chain);
    }
    for (const id of order) {
        if (!visited.has(id)) {
            visited.add(id);
            chains.push([id]);
        }
    }
    return chains;
}

function annotationsByCard(anns: AnnotationDto[]): Map<number, ScrapeAnnotation[]> {
    const out = new Map<number, ScrapeAnnotation[]>();
    for (const a of anns) {
        const intent = a.intent === "other" && a.intentOther ? a.intentOther : a.intent;
        const sa: ScrapeAnnotation = {
            id: a.id,
            intent,
            status: a.status,
            prompt: a.prompt,
            ...(a.createdBy ? { by: a.createdBy } : {}),
        };
        out.set(a.cardId, [...(out.get(a.cardId) ?? []), sa]);
    }
    return out;
}

function toScrapeCard(card: CardDto, owner: SectionCard | null, base: string, anns: ScrapeAnnotation[]): ScrapeCard {
    const e: ScrapeCard = {
        id: card.id,
        kind: card.kind,
        ai: card.payload.layer === "ai",
    };
    if (card.createdBy) {
        e.by = card.createdBy;
    }
    if (owner) {
        e.section = str(owner.payload, "title");
    }
    if (card.blobKey) {
        e.image = `${base}${blobUrl(card.blobKey)}`;
    }
    const text = cardText(card.kind, card.payload);
    if (text) {
        e.text = text;
    }
    if (anns.length > 0) {
        e.annotations = anns;
    }
    return e;
}

/** Scrape the board into a digest. `section` narrows to one frame's members; `diff=A,B` returns the
 *  pairwise iteration digest; the two are mutually exclusive. */
export function scrapeBoard(opts: { doc: BoardDocDto; base?: string; section?: string; diff?: string }): ScrapeResult {
    const { doc } = opts;
    const base = opts.base ?? "";
    const cards = doc.cards;
    const frames = sectionFrames(cards);
    const annByCard = annotationsByCard(doc.annotations);

    let only: SectionCard | null = null;
    if (opts.section) {
        only = sectionByName(frames, opts.section);
        if (!only) {
            return { ok: false, status: 404, message: `no section named "${opts.section}" on this board` };
        }
    }
    if (opts.diff && only) {
        return { ok: false, status: 400, message: "section and diff are mutually exclusive" };
    }

    const entries = new Map<number, ScrapeCard>();
    const pos = new Map<number, { x: number; y: number }>();
    const order: number[] = [];
    for (const card of cards) {
        if (card.kind === "section") {
            continue; // frames live in sections[], not the card list
        }
        const owner = frames.length > 0 ? containingSection(frames, card) : null;
        if (only && owner?.id !== only.id) {
            continue;
        }
        entries.set(card.id, toScrapeCard(card, owner, base, annByCard.get(card.id) ?? []));
        pos.set(card.id, { x: card.x, y: card.y });
        order.push(card.id);
    }

    const board = { slug: doc.board.slug, title: doc.board.title };

    if (opts.diff) {
        const parts = opts.diff.split(",");
        if (parts.length !== 2 || !parts[0].trim() || !parts[1].trim()) {
            return { ok: false, status: 400, message: "diff wants two section names: ?diff=A,B" };
        }
        const sa = sectionByName(frames, parts[0]);
        const sb = sectionByName(frames, parts[1]);
        if (!sa || !sb) {
            return { ok: false, status: 404, message: "no such section on this board" };
        }
        // Members as CardDto (they carry filePath, which pairSectionMembers matches on).
        const membersOf = (sec: SectionCard): CardDto[] =>
            cards.filter((c) => c.kind !== "section" && containingSection(frames, c)?.id === sec.id);
        const ma = membersOf(sa);
        const mb = membersOf(sb);
        const pairs = pairSectionMembers(ma, mb).map((p) => ({
            ...(p.a ? { a: entries.get(p.a.id) } : {}),
            ...(p.b ? { b: entries.get(p.b.id) } : {}),
        }));
        return {
            ok: true,
            body: {
                board,
                a: { name: str(sa.payload, "title"), cards: ma.length },
                b: { name: str(sb.payload, "title"), cards: mb.length },
                pairs,
            },
        };
    }

    const flow = walkFlow(order, pos, doc.edges);
    const seen = new Set<number>();
    const outCards: ScrapeCard[] = [];
    for (const chain of flow) {
        for (const id of chain) {
            const e = entries.get(id);
            if (e && !seen.has(id)) {
                seen.add(id);
                outCards.push(e);
            }
        }
    }
    for (const id of order) {
        const e = entries.get(id);
        if (e && !seen.has(id)) {
            seen.add(id);
            outCards.push(e);
        }
    }

    const body: Record<string, unknown> = {
        board,
        sections: sectionsToJSON(cards).sections,
        flow,
        cards: outCards,
    };
    const journeys = sectionsToJSON(cards).journeys;
    if (journeys.length > 0) {
        body.journeys = journeys;
    }
    return { ok: true, body };
}
