import * as chrono from "chrono-node";
import type { QueryRequest } from "./types";

const ISO_DATE_PATTERN = /(\d{4}-\d{2}-\d{2})/g;

function toIsoDate(date: Date): string {
    return date.toISOString().slice(0, 10);
}

function parseDatePhrase(phrase: string, referenceDate: Date): string | undefined {
    const parsed = chrono.parseDate(phrase.trim(), referenceDate);

    if (!parsed) {
        return undefined;
    }

    return toIsoDate(parsed);
}

export class QueryParser {
    parseFromFlags(request: QueryRequest): QueryRequest {
        const parsed = { ...request };
        const now = new Date();

        if (parsed.since) {
            const normalizedSince = parseDatePhrase(parsed.since, now);

            if (normalizedSince) {
                parsed.since = normalizedSince;
            }
        }

        if (parsed.until) {
            const normalizedUntil = parseDatePhrase(parsed.until, now);

            if (normalizedUntil) {
                parsed.until = normalizedUntil;
            }
        }

        if (request.nl) {
            const extracted = this.parseNaturalLanguage(request.nl, now);

            if (!parsed.from && extracted.from) {
                parsed.from = extracted.from;
            }

            if (!parsed.since && extracted.since) {
                parsed.since = extracted.since;
            }

            if (!parsed.until && extracted.until) {
                parsed.until = extracted.until;
            }

            if (!parsed.sender && extracted.sender) {
                parsed.sender = extracted.sender;
            }

            if (!parsed.text && extracted.text) {
                parsed.text = extracted.text;
            }
        }

        if (!parsed.sender) {
            parsed.sender = "any";
        }

        return parsed;
    }

    parseNaturalLanguage(input: string, referenceDate: Date = new Date()): Partial<QueryRequest> {
        const normalized = input.trim();
        const result: Partial<QueryRequest> = {};

        const fromMatch = normalized.match(/messages\s+from\s+(.+?)(?:\s+since|\s+until|\s+text|\s+matching|$)/i);

        if (fromMatch) {
            result.from = fromMatch[1].trim();
        }

        const sincePhraseMatch = normalized.match(/since\s+(.+?)(?:\s+until|\s+text|\s+matching|$)/i);
        const untilPhraseMatch = normalized.match(/until\s+(.+?)(?:\s+since|\s+text|\s+matching|$)/i);

        if (sincePhraseMatch) {
            const parsed = parseDatePhrase(sincePhraseMatch[1], referenceDate);

            if (parsed) {
                result.since = parsed;
            }
        }

        if (untilPhraseMatch) {
            const parsed = parseDatePhrase(untilPhraseMatch[1], referenceDate);

            if (parsed) {
                result.until = parsed;
            }
        }

        if (!result.since || !result.until) {
            const chronoResults = chrono.parse(normalized, referenceDate, { forwardDate: false });

            for (const chronoResult of chronoResults) {
                if (!result.since && chronoResult.start) {
                    result.since = toIsoDate(chronoResult.start.date());
                }

                if (!result.until) {
                    if (chronoResult.end) {
                        result.until = toIsoDate(chronoResult.end.date());
                    } else if (chronoResult.start) {
                        result.until = toIsoDate(chronoResult.start.date());
                    }
                }
            }
        }

        const isoDates = [...normalized.matchAll(ISO_DATE_PATTERN)].map((match) => match[1]);

        if (!result.since && isoDates.length > 0) {
            result.since = isoDates[0];
        }

        if (!result.until && isoDates.length > 1) {
            result.until = isoDates[1];
        }

        if (/\bfrom\s+me\b/i.test(normalized) || /\bmy messages\b/i.test(normalized)) {
            result.sender = "me";
        }

        if (/\bfrom\s+(her|him|them)\b/i.test(normalized) || /\btheir messages\b/i.test(normalized)) {
            result.sender = "them";
        }

        const textMatch = normalized.match(/matching\s+"([^"]+)"/i) ?? normalized.match(/text\s+"([^"]+)"/i);

        if (textMatch) {
            result.text = textMatch[1];
        }

        return result;
    }
}

export const queryParser = new QueryParser();
