// Journey sections (vitrinka internal/web/sections.go): a section is a kind "section" frame card
// named after a customer journey. Membership is SPATIAL — a card belongs to the smallest section
// whose bounds contain its center, computed at read time — so there is no children bookkeeping.

// Minimal structural view of a board card (CardDto is a structural superset).
export interface SectionCard {
    id: number;
    kind: string;
    x: number;
    y: number;
    w: number;
    h: number;
    payload: Record<string, unknown>;
    createdBy?: string;
}

const ZERO_W = 340; // legacy zero-size membership footprint (cardCenter probe)
const ZERO_H = 220;
const PASS_GUTTER = 80; // side-by-side gap between consecutive pass frames
const DEFAULT_FRAME_W = 960;
const DEFAULT_FRAME_H = 640;

function str(payload: Record<string, unknown>, key: string): string {
    return typeof payload[key] === "string" ? (payload[key] as string) : "";
}

/** Section frames in reading order (top-to-bottom, then left-to-right) — vitrinka sortsectionsOf
 *  by raw Y then X (NOT banded), so the pill bar / scrape order matches. */
export function sectionFrames(cards: SectionCard[]): SectionCard[] {
    return cards
        .filter((c) => c.kind === "section")
        .slice()
        .sort((a, b) => (a.y !== b.y ? a.y - b.y : a.x - b.x));
}

export function sectionTitle(card: SectionCard): string {
    return str(card.payload, "title");
}

/** Normalize a journey name to its chain key: lowercase, non-alnum runs collapsed to single dashes,
 *  no leading/trailing dash — "Checkout Flow" and "checkout-flow" chain up. */
export function journeyKey(s: string): string {
    const lower = s.trim().toLowerCase();
    let out = "";
    let dash = false;
    for (const ch of lower) {
        if ((ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9")) {
            out += ch;
            dash = false;
        } else if (!dash && out.length > 0) {
            out += "-";
            dash = true;
        }
    }
    return out.replace(/-+$/, "");
}

/** Reads payload.{journey, pass}; journey "" = a plain section. pass floors to 1. */
export function sectionJourney(card: SectionCard): { journey: string; pass: number } {
    const journeyRaw = str(card.payload, "journey");
    if (!journeyRaw) {
        return { journey: "", pass: 0 };
    }
    const passRaw = card.payload.pass;
    const pass = typeof passRaw === "number" && passRaw >= 1 ? passRaw : 1;
    return { journey: journeyKey(journeyRaw), pass };
}

/** A journey's sections ordered by pass (input assumed reading-sorted for stable ties). */
function passChain(frames: SectionCard[], journey: string): SectionCard[] {
    const key = journeyKey(journey);
    if (!key) {
        return [];
    }
    return frames
        .filter((sec) => sectionJourney(sec).journey === key)
        .slice()
        .sort((a, b) => sectionJourney(a).pass - sectionJourney(b).pass);
}

/** Strip the " — pass N" suffix so pass N+1 inherits the human name. */
export function journeyBaseTitle(title: string): string {
    const i = title.lastIndexOf(" — pass ");
    return i >= 0 ? title.slice(0, i) : title;
}

/** Title-case a raw journey input for a fresh chain ("checkout-flow" → "Checkout Flow"). */
export function journeyHumanTitle(raw: string): string {
    return raw
        .trim()
        .split(/[-_ ]+/)
        .filter((f) => f.length > 0)
        .map((f) => f[0].toUpperCase() + f.slice(1))
        .join(" ");
}

/** Membership probe point — zero-size legacy cards get the default footprint. */
export function cardCenter(card: SectionCard): { cx: number; cy: number } {
    const w = card.w > 0 ? card.w : ZERO_W;
    const h = card.h > 0 ? card.h : ZERO_H;
    return { cx: card.x + w / 2, cy: card.y + h / 2 };
}

/** The SMALLEST section frame whose bounds contain the card's center; null when none holds it. */
export function containingSection(frames: SectionCard[], card: SectionCard): SectionCard | null {
    const { cx, cy } = cardCenter(card);
    let best: SectionCard | null = null;
    let bestArea = Number.POSITIVE_INFINITY;
    for (const s of frames) {
        if (cx < s.x || cy < s.y || cx > s.x + s.w || cy > s.y + s.h) {
            continue;
        }
        const area = s.w * s.h;
        if (best === null || area < bestArea) {
            best = s;
            bestArea = area;
        }
    }
    return best;
}

/** Resolve a section frame by its journey title, case-insensitively. */
export function sectionByName(frames: SectionCard[], name: string): SectionCard | null {
    const want = name.trim().toLowerCase();
    return frames.find((s) => sectionTitle(s).trim().toLowerCase() === want) ?? null;
}

/** Non-section cards whose center sits in the named section (smallest-wins, so a nested section's
 *  cards aren't double-counted). Empty when the section name is unknown. */
export function sectionMembers(frames: SectionCard[], cards: SectionCard[], name: string): SectionCard[] {
    const sec = sectionByName(frames, name);
    if (!sec) {
        return [];
    }
    return cards.filter((c) => c.kind !== "section" && containingSection(frames, c)?.id === sec.id);
}

export interface SectionJSON {
    id: number;
    name: string;
    x: number;
    y: number;
    w: number;
    h: number;
    cards: number;
    order: number;
    by?: string;
    journey?: string;
    pass?: number;
}

export interface JourneyJSON {
    journey: string;
    title: string;
    passes: number;
    latest: string;
}

/** The one-line orientation summary per pass chain. */
export function listJourneys(frames: SectionCard[]): JourneyJSON[] {
    const seen = new Set<string>();
    const out: JourneyJSON[] = [];
    for (const sec of frames) {
        const { journey } = sectionJourney(sec);
        if (!journey || seen.has(journey)) {
            continue;
        }
        seen.add(journey);
        const chain = passChain(frames, journey);
        const last = chain[chain.length - 1];
        out.push({
            journey,
            title: journeyBaseTitle(sectionTitle(last)),
            passes: chain.length,
            latest: sectionTitle(last),
        });
    }
    return out;
}

/** GET .../sections payload: every journey section with bounds, member count and reading order,
 *  plus the pass-chain summaries. */
export function sectionsToJSON(cards: SectionCard[]): { sections: SectionJSON[]; journeys: JourneyJSON[] } {
    const frames = sectionFrames(cards);
    const members = new Map<number, number>();
    for (const c of cards) {
        if (c.kind === "section") {
            continue;
        }
        const owner = containingSection(frames, c);
        if (owner) {
            members.set(owner.id, (members.get(owner.id) ?? 0) + 1);
        }
    }
    const sections = frames.map((sec, order) => {
        const { journey, pass } = sectionJourney(sec);
        const j: SectionJSON = {
            id: sec.id,
            name: sectionTitle(sec),
            x: sec.x,
            y: sec.y,
            w: sec.w,
            h: sec.h,
            cards: members.get(sec.id) ?? 0,
            order,
            ...(sec.createdBy ? { by: sec.createdBy } : {}),
            ...(journey ? { journey, pass } : {}),
        };
        return j;
    });
    return { sections, journeys: listJourneys(frames) };
}

/** Descriptor for compose's {journey, pass} target. `resolveJourneyPass` is pure over cards; the
 *  caller (compose store) applies the side effect (adopt-patch / create-insert) inside its tx. */
export type JourneyPassResolution =
    | { action: "existing"; section: SectionCard }
    | { action: "adopt"; section: SectionCard; journey: string }
    | { action: "create"; frame: { x: number; y: number; w: number; h: number; payload: Record<string, unknown> } }
    | { action: "error"; code: "bad_journey"; message: string };

/** Resolve compose's {journey, pass} target (passes decisions §3). pass omitted = the chain's latest
 *  (or pass 1 if none); "next"/max+1 creates the next pass beside pass N−1 with layout inherited; a
 *  number targets that existing pass; a gap (>max+1) errors. Mirrors sections.go:135-252 (minus DB). */
export function resolveJourneyPass(opts: {
    cards: SectionCard[];
    journey: string;
    pass?: number | "next";
}): JourneyPassResolution {
    const key = journeyKey(opts.journey);
    if (!key) {
        return { action: "error", code: "bad_journey", message: "journey must contain letters or digits" };
    }
    const frames = sectionFrames(opts.cards);
    let chain = passChain(frames, key);

    // A plain section whose TITLE matches the journey seeds the chain as pass 1. Treat it as pass 1
    // for the chain math here; the caller stamps the real journey/pass when it applies the "adopt".
    let adoptTarget: SectionCard | null = null;
    if (chain.length === 0) {
        const named = sectionByName(frames, opts.journey);
        if (named && sectionJourney(named).journey === "") {
            adoptTarget = named;
            chain = [{ ...named, payload: { ...named.payload, journey: key, pass: 1 } }];
        }
    }
    const maxPass = chain.length > 0 ? sectionJourney(chain[chain.length - 1]).pass : 0;

    // Parse the pass selector.
    let want = 0;
    let create = false;
    if (opts.pass === undefined) {
        if (chain.length === 0) {
            want = 1;
            create = true;
        } else {
            want = maxPass;
        }
    } else if (opts.pass === "next") {
        want = maxPass + 1;
        create = true;
    } else if (typeof opts.pass === "number" && opts.pass >= 1) {
        want = opts.pass;
        if (want === maxPass + 1) {
            create = true;
        } else if (want > maxPass + 1) {
            return {
                action: "error",
                code: "bad_journey",
                message: `journey "${key}" has ${maxPass} passes — pass ${want} would leave a gap (use ${maxPass + 1} or "next")`,
            };
        }
    } else {
        return { action: "error", code: "bad_journey", message: 'pass: "next" or a pass number' };
    }

    if (!create) {
        const found = chain.find((c) => sectionJourney(c).pass === want);
        if (found) {
            // An adopted plain section resolving to pass 1 still needs the journey stamp applied.
            if (adoptTarget && adoptTarget.id === found.id) {
                return { action: "adopt", section: adoptTarget, journey: key };
            }
            return { action: "existing", section: found };
        }
        return { action: "error", code: "bad_journey", message: `journey "${key}" has no pass ${want}` };
    }

    // Create the next pass frame: name from the previous pass's base title, placed beside it.
    const prev = chain.length > 0 ? chain[chain.length - 1] : null;
    const payload: Record<string, unknown> = { journey: key, pass: want };
    let x = 80;
    let y = 80;
    let w = DEFAULT_FRAME_W;
    let h = DEFAULT_FRAME_H;
    let title = journeyHumanTitle(opts.journey);
    if (prev) {
        title = journeyBaseTitle(sectionTitle(prev));
        if (prev.payload.layout !== undefined) {
            payload.layout = prev.payload.layout;
        }
        w = prev.w;
        h = prev.h;
        x = prev.x + prev.w + PASS_GUTTER;
        y = prev.y;
    } else if (opts.cards.length > 0) {
        let maxX = Number.NEGATIVE_INFINITY;
        let minY = Number.POSITIVE_INFINITY;
        for (const c of opts.cards) {
            const cw = c.w > 0 ? c.w : ZERO_W;
            maxX = Math.max(maxX, c.x + cw);
            minY = Math.min(minY, c.y);
        }
        x = maxX + PASS_GUTTER;
        y = minY;
    }
    if (want > 1) {
        title = `${title} — pass ${want}`;
    }
    payload.title = title;
    return { action: "create", frame: { x, y, w, h, payload } };
}
