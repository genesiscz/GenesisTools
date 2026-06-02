import type { RedactOptions, RedactType, Span } from "./types";

type Detector = (text: string, opts: RedactOptions) => Span[];

function spansFromRegex(text: string, re: RegExp, type: RedactType, group = 0): Span[] {
    const spans: Span[] = [];
    const rx = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
    let m: RegExpExecArray | null = rx.exec(text);
    while (m !== null) {
        const value = m[group];
        if (value !== undefined && value.length > 0) {
            const start = group === 0 ? m.index : m.index + m[0].indexOf(value);
            spans.push({ start, end: start + value.length, type, value });
        }

        if (m.index === rx.lastIndex) {
            rx.lastIndex++;
        }

        m = rx.exec(text);
    }

    return spans;
}

const AWS_KEY = /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/;
const PRIVATE_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/;
const GITHUB = /\bgh[pousr]_[A-Za-z0-9]{36,}\b/;
const SLACK = /\bxox[bpars]-[A-Za-z0-9-]{10,}\b/;
const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/;
const IPV4 = /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/;
const IPV6 = /\b(?:[A-Fa-f0-9]{1,4}:){2,7}[A-Fa-f0-9]{1,4}\b/;
const BEARER = /\bBearer\s+([A-Za-z0-9._-]{12,})/;
const GENERIC = /\b(?:secret|token|password|passwd|apikey|api_key)\b\s*[:=]\s*["']?([^"'\s]{12,})["']?/i;
const PHONE = /(?:\+\d{1,3}[\s-]?)?(?:\(?\d{2,4}\)?[\s-]?){2,4}\d{2,4}/;

function detectHomePaths(text: string, homeDir: string): Span[] {
    if (homeDir.length === 0) {
        return [];
    }

    const spans: Span[] = [];
    let from = 0;
    let idx = text.indexOf(homeDir, from);
    while (idx !== -1) {
        spans.push({ start: idx, end: idx + homeDir.length, type: "paths", value: homeDir });
        from = idx + homeDir.length;
        idx = text.indexOf(homeDir, from);
    }

    return spans;
}

const detectors: Record<RedactType, Detector> = {
    keys: (text) => [...spansFromRegex(text, AWS_KEY, "keys"), ...spansFromRegex(text, PRIVATE_KEY, "keys")],
    tokens: (text) => [
        ...spansFromRegex(text, GITHUB, "tokens"),
        ...spansFromRegex(text, SLACK, "tokens"),
        ...spansFromRegex(text, BEARER, "tokens", 1),
        ...spansFromRegex(text, GENERIC, "tokens", 1),
    ],
    emails: (text) => spansFromRegex(text, EMAIL, "emails"),
    ips: (text) => [...spansFromRegex(text, IPV4, "ips"), ...spansFromRegex(text, IPV6, "ips")],
    paths: (text, opts) => detectHomePaths(text, opts.homeDir),
    phones: (text) => spansFromRegex(text, PHONE, "phones"),
};

export function detectAll(text: string, opts: RedactOptions): Span[] {
    const spans: Span[] = [];
    for (const type of opts.types) {
        spans.push(...detectors[type](text, opts));
    }

    return spans;
}
