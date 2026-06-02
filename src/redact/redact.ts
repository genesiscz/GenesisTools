import { detectAll } from "./detectors";
import type { Mapping, RedactOptions, RedactResult, RedactType, Span } from "./types";

const PREFIX: Record<RedactType, string> = {
    keys: "REDACTED_KEY",
    tokens: "REDACTED_TOKEN",
    emails: "EMAIL",
    ips: "IP",
    paths: "HOME",
    phones: "PHONE",
};

function mergeSpans(spans: Span[]): Span[] {
    const sorted = [...spans].sort((a, b) => a.start - b.start || b.end - a.end);
    const accepted: Span[] = [];
    let lastEnd = -1;
    for (const span of sorted) {
        if (span.start >= lastEnd) {
            accepted.push(span);
            lastEnd = span.end;
        }
    }

    return accepted;
}

interface AssignState {
    mapping: Mapping;
    valueToToken: Map<string, string>;
    counters: Map<RedactType, number>;
}

function placeholderFor(span: Span, state: AssignState): string {
    const { mapping, valueToToken, counters } = state;
    const existing = valueToToken.get(span.value);
    if (existing !== undefined) {
        return existing;
    }

    if (span.type === "paths") {
        const token = "[HOME]";
        valueToToken.set(span.value, token);
        mapping[token] = span.value;
        return token;
    }

    const next = (counters.get(span.type) ?? 0) + 1;
    counters.set(span.type, next);
    const token = `[${PREFIX[span.type]}_${next}]`;
    valueToToken.set(span.value, token);
    mapping[token] = span.value;
    return token;
}

export function redact(text: string, opts: RedactOptions): RedactResult {
    const spans = mergeSpans(detectAll(text, opts));
    const state: AssignState = {
        mapping: {},
        valueToToken: new Map<string, string>(),
        counters: new Map<RedactType, number>(),
    };

    let result = "";
    let cursor = 0;
    for (const span of spans) {
        result += text.slice(cursor, span.start);
        result += placeholderFor(span, state);
        cursor = span.end;
    }

    result += text.slice(cursor);
    return { redacted: result, mapping: state.mapping };
}
