import { observedRows } from "@app/control/lib/decision/observation";
import type { SurfaceSnapshot } from "./surface";

/** A screen as the stall and repeat checks compare it: whose it is, and one line per visible thing. */
export interface ScreenSignature {
    identity: string;
    lines: string[];
}

/**
 * One changed line is noise only when it is at most a tenth of the screen: a clock digit on a
 * forty-line page is not progress, the same single change on a five-line dialog is. Ported from
 * typesafe-computer-use `models.same_screen`.
 */
const MAX_DIFFERING_LINES = 1;
const LINES_PER_DIFFERENCE = 10;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
    return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? String(value) : "";
}

const TEXT_PIECE = 120;
const MAX_TEXT_LINES = 200;

/**
 * A page's visible text as lines that a small change touches only one of: sentences, each cut into
 * 120-character pieces. A result, a receipt or a progress line that changes only in text is then a
 * new screen, while one clock digit on a long page stays one line of noise.
 */
function textLines(value: unknown): string[] {
    if (typeof value !== "string") {
        return [];
    }

    const lines: string[] = [];
    for (const sentence of value.split(/(?<=[.!?])\s+/)) {
        for (let start = 0; start < sentence.length && lines.length < MAX_TEXT_LINES; start += TEXT_PIECE) {
            lines.push(`text|${sentence.slice(start, start + TEXT_PIECE)}`);
        }
    }

    return lines;
}

/**
 * Evidence rows without their ids: a page snapshot numbers its nodes afresh on every read, so an id
 * would make every screen look new. Knows the three shapes surfaces emit: a row list, a page
 * `{ nodes, text }`, and the auto surface's `{ native, page }`.
 */
function evidenceLines(evidence: unknown): string[] {
    if (Array.isArray(evidence)) {
        return evidence.filter(isRecord).map((row) => [text(row.role), text(row.label), text(row.value)].join("|"));
    }

    if (!isRecord(evidence)) {
        return [];
    }

    if (Array.isArray(evidence.nodes)) {
        return [...evidenceLines(evidence.nodes), ...textLines(evidence.text)];
    }

    return [...evidenceLines(evidence.native), ...evidenceLines(evidence.page)];
}

export function screenOf(snapshot: SurfaceSnapshot): ScreenSignature {
    const native = snapshot.observation
        ? observedRows(snapshot.observation).map((row) =>
              [row.role, row.label, row.value, text(row.checked), text(row.url)].join("|")
          )
        : [];
    const offered = snapshot.candidates.map((row) => [row.action, row.role ?? "", row.label].join("|"));
    return { identity: snapshot.label, lines: [...native, ...evidenceLines(snapshot.evidence), ...offered] };
}

export function sameScreen(a: ScreenSignature, b: ScreenSignature): boolean {
    if (a.identity !== b.identity) {
        return false;
    }

    const remaining = new Map<string, number>();
    for (const line of a.lines) {
        remaining.set(line, (remaining.get(line) ?? 0) + 1);
    }

    let onlyInB = 0;
    for (const line of b.lines) {
        const count = remaining.get(line) ?? 0;
        if (count > 0) {
            remaining.set(line, count - 1);
        } else {
            onlyInB += 1;
        }
    }

    const onlyInA = [...remaining.values()].reduce((total, count) => total + count, 0);
    const differing = Math.max(onlyInA, onlyInB);
    if (differing === 0) {
        return true;
    }

    const total = Math.max(a.lines.length, b.lines.length);
    return differing <= MAX_DIFFERING_LINES && differing * LINES_PER_DIFFERENCE <= total;
}
