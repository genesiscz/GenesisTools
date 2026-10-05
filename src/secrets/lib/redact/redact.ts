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
    reserved: Set<string>;
}

function isTaken(token: string, state: AssignState): boolean {
    return state.reserved.has(token) || state.mapping[token] !== undefined;
}

function placeholderFor(span: Span, state: AssignState): string {
    const { mapping, valueToToken, counters } = state;
    const existing = valueToToken.get(span.value);
    if (existing !== undefined) {
        return existing;
    }

    let token: string;
    if (span.type === "paths") {
        token = "[HOME]";
        let suffix = 1;
        while (isTaken(token, state)) {
            suffix += 1;
            token = `[HOME_${suffix}]`;
        }
    } else {
        let next = counters.get(span.type) ?? 0;
        do {
            next += 1;
            token = `[${PREFIX[span.type]}_${next}]`;
        } while (isTaken(token, state));

        counters.set(span.type, next);
    }

    valueToToken.set(span.value, token);
    mapping[token] = span.value;
    return token;
}

function collectExistingTokens(text: string): Set<string> {
    const reserved = new Set<string>();
    const rx = /\[[A-Z0-9_]+\]/g;
    let m: RegExpExecArray | null = rx.exec(text);
    while (m !== null) {
        reserved.add(m[0]);
        m = rx.exec(text);
    }

    return reserved;
}

export function redact(text: string, opts: RedactOptions): RedactResult {
    const spans = mergeSpans(detectAll(text, opts));
    const state: AssignState = {
        mapping: {},
        valueToToken: new Map<string, string>(),
        counters: new Map<RedactType, number>(),
        reserved: collectExistingTokens(text),
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
