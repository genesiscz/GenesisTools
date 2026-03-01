import type { QueryRequest } from "./types";

const DATE_PATTERN = /(\d{4}-\d{2}-\d{2})/g;

export class QueryParser {
    parseFromFlags(request: QueryRequest): QueryRequest {
        const parsed = { ...request };

        if (request.nl) {
            const extracted = this.parseNaturalLanguage(request.nl);

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

    parseNaturalLanguage(input: string): Partial<QueryRequest> {
        const normalized = input.trim();
        const result: Partial<QueryRequest> = {};

        const fromMatch = normalized.match(/messages\s+from\s+(.+?)(?:\s+since|\s+until|\s+text|\s+matching|$)/i);

        if (fromMatch) {
            result.from = fromMatch[1].trim();
        }

        const sinceMatch = normalized.match(/since\s+(\d{4}-\d{2}-\d{2})/i);

        if (sinceMatch) {
            result.since = sinceMatch[1];
        }

        const untilMatch = normalized.match(/until\s+(\d{4}-\d{2}-\d{2})/i);

        if (untilMatch) {
            result.until = untilMatch[1];
        }

        const dates = [...normalized.matchAll(DATE_PATTERN)].map((match) => match[1]);

        if (!result.since && dates.length > 0) {
            result.since = dates[0];
        }

        if (!result.until && dates.length > 1) {
            result.until = dates[1];
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
