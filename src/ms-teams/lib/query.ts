import * as chrono from "chrono-node";
import { decodeTeamsString } from "./decode";

export interface ShowQuery {
    withName?: string;
    topic?: string;
    id?: string;
    from?: Date;
    to?: Date;
    raw: string;
}

const THREAD_ID_RE = /^19:[^\s]+@(?:thread\.v2|thread\.tacv2|unq\.gbl\.spaces)$/i;
const ISO_DATE_RE = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)Z?)?$/;
const DOT_DATE_RE = /^(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4})$/;

/**
 * Parse a free-text show query such as
 * `conversation with Ada Lovelace from 2026-08-06 to 2026-08-06`.
 */
export function parseShowQuery(input: string): ShowQuery {
    const raw = decodeTeamsString(input).trim();
    const result: ShowQuery = { raw };

    if (!raw) {
        return result;
    }

    if (THREAD_ID_RE.test(raw)) {
        result.id = raw;
        return result;
    }

    let rest = raw;
    rest = takeRange(rest, result);
    rest = takeWith(rest, result);
    rest = rest
        .replace(/^(?:conversation|chat|meeting|thread)\s+/i, "")
        .replace(/\s+/g, " ")
        .trim();

    if (THREAD_ID_RE.test(rest)) {
        result.id = rest;
        return result;
    }

    if (rest.length > 0) {
        result.topic = rest;
    }

    return result;
}

export function mergeShowQuery(parsed: ShowQuery, flags: Partial<ShowQuery>): ShowQuery {
    return {
        raw: parsed.raw,
        withName: flags.withName ?? parsed.withName,
        topic: flags.topic ?? parsed.topic,
        id: flags.id ?? parsed.id,
        from: flags.from ?? parsed.from,
        to: flags.to ?? parsed.to,
    };
}

function takeWith(rest: string, result: ShowQuery): string {
    const match = rest.match(/\b(?:conversation|chat|meeting)?\s*with\s+(.+)$/i);

    if (!match) {
        return rest;
    }

    const before = rest.slice(0, match.index).trim();
    result.withName = cleanName(match[1]);
    return before;
}

function takeRange(rest: string, result: ShowQuery): string {
    const fromMatch = rest.match(/\b(?:from|since)\s+(.+?)(?=\s+(?:to|until|till|with)\b|$)/i);

    if (fromMatch) {
        const parsed = parseQueryDate(fromMatch[1].trim(), "start");

        if (parsed) {
            result.from = parsed;
            rest = rest.replace(fromMatch[0], " ").replace(/\s+/g, " ").trim();
        }
    }

    const toMatch = rest.match(/\b(?:to|until|till)\s+(.+?)(?=\s+(?:from|since|with)\b|$)/i);

    if (toMatch) {
        const parsed = parseQueryDate(toMatch[1].trim(), "end");

        if (parsed) {
            result.to = parsed;
            rest = rest.replace(toMatch[0], " ").replace(/\s+/g, " ").trim();
        }
    }

    return rest;
}

function cleanName(value: string): string {
    return value
        .replace(/\b(?:from|since|to|until|till)\s+.+$/i, "")
        .replace(/\s+/g, " ")
        .trim();
}

export function parseQueryDate(value: string, bound: "start" | "end"): Date | undefined {
    const trimmed = value.trim();

    if (!trimmed) {
        return undefined;
    }

    const iso = trimmed.match(ISO_DATE_RE);

    if (iso) {
        const day = iso[1];
        const time = iso[2];

        if (time) {
            const d = new Date(`${day}T${time}${trimmed.endsWith("Z") ? "Z" : ""}`);

            if (!Number.isNaN(d.getTime())) {
                return d;
            }
        }

        return bound === "start" ? startOfLocalDay(day) : endOfLocalDay(day);
    }

    const dotted = trimmed.match(DOT_DATE_RE);

    if (dotted) {
        const day = `${dotted[3]}-${dotted[2].padStart(2, "0")}-${dotted[1].padStart(2, "0")}`;
        return bound === "start" ? startOfLocalDay(day) : endOfLocalDay(day);
    }

    const chronoDate = chrono.parseDate(trimmed);

    if (!chronoDate) {
        return undefined;
    }

    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed) || DOT_DATE_RE.test(trimmed) || !/\d{1,2}:\d{2}/.test(trimmed)) {
        const ymd = `${chronoDate.getFullYear()}-${String(chronoDate.getMonth() + 1).padStart(2, "0")}-${String(chronoDate.getDate()).padStart(2, "0")}`;
        return bound === "start" ? startOfLocalDay(ymd) : endOfLocalDay(ymd);
    }

    return chronoDate;
}

function startOfLocalDay(ymd: string): Date {
    const [y, m, d] = ymd.split("-").map(Number);
    return new Date(y, m - 1, d, 0, 0, 0, 0);
}

function endOfLocalDay(ymd: string): Date {
    const [y, m, d] = ymd.split("-").map(Number);
    return new Date(y, m - 1, d, 23, 59, 59, 999);
}
