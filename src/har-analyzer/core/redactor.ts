/**
 * Structure-aware PII/credential redaction for HAR files.
 *
 * Design constraints:
 * - Key-based redaction uses EXACT normalized-name matches (never substring),
 *   so `token_type` ("Bearer") and JSON error `code` fields survive untouched.
 * - Value-based patterns are limited to unmistakable shapes (JWT, email) and
 *   emails match only inside structured values (JSON/form/query), never
 *   raw HTML, to avoid scrubbing contact addresses out of page content.
 * - Masks are recognizable, so an already-masked value is never re-masked and
 *   a second pass reporting zero changes doubles as output verification.
 *
 * Mask styles (per kind, overridable):
 * - "stars": full mask preserving length (`hunter2` -> `*******`)
 * - "partial": keep head+tail for correlation (`opaq[***]alue`); emails keep
 *   their domain (`******@example.com`); short values fall back to stars
 * - "label": `[REDACTED:<kind>]`
 * - "keep": leave the value untouched
 */
import type { HarEntry, HarFile, HarHeader } from "@app/har-analyzer/types";
import { SafeJSON } from "@genesiscz/utils/json";

export type RedactionKind = "password" | "secret" | "token" | "session" | "email" | "username" | "cookie" | "jwt";

export type MaskStyle = "label" | "stars" | "partial" | "keep";

export const REDACTION_KINDS: RedactionKind[] = [
    "password",
    "secret",
    "token",
    "session",
    "email",
    "username",
    "cookie",
    "jwt",
];

export const MASK_STYLES: MaskStyle[] = ["label", "stars", "partial", "keep"];

export interface RedactorOptions {
    /** Redact only these kinds (wins over `skip`). */
    only?: RedactionKind[];
    /** Kinds to leave untouched. */
    skip?: RedactionKind[];
    /** Per-kind mask style overrides. */
    styles?: Partial<Record<RedactionKind, MaskStyle>>;
}

export interface RedactionChange {
    entryIndex: number;
    location: string;
    kind: RedactionKind;
    count: number;
}

export interface RedactionResult {
    har: HarFile;
    changes: RedactionChange[];
    skipped: string[];
}

const DEFAULT_STYLES: Record<RedactionKind, MaskStyle> = {
    password: "stars",
    secret: "stars",
    username: "stars",
    email: "partial",
    token: "partial",
    session: "partial",
    cookie: "partial",
    jwt: "partial",
};

const PARTIAL_MIN_LENGTH = 16;
const PARTIAL_MAX_REVEAL_PER_SIDE = 12;
const STARS_MAX_LENGTH = 64;
const PARTIAL_GAP = "[***]";

const LABEL_RE = /^\[REDACTED:[a-z-]+\]$/;
const STARS_RE = /^\*+$/;
const MASKED_EMAIL_RE = /^\*+@/;

/** Normalize a key for exact matching: lowercase, strip separators. */
function normalizeKey(key: string): string {
    return key.toLowerCase().replace(/[-_.\s]/g, "");
}

const KEY_KINDS: Record<string, RedactionKind> = {
    // Passwords
    password: "password",
    passwd: "password",
    pwd: "password",
    jpassword: "password",
    heslo: "password",
    currentpassword: "password",
    newpassword: "password",
    oldpassword: "password",
    confirmpassword: "password",
    passwordconfirmation: "password",
    // Secrets / keys
    secret: "secret",
    clientsecret: "secret",
    apikey: "secret",
    apisecret: "secret",
    privatekey: "secret",
    clientassertion: "secret",
    samlresponse: "secret",
    assertion: "secret",
    // Tokens
    token: "token",
    accesstoken: "token",
    refreshtoken: "token",
    idtoken: "token",
    idtokenhint: "token",
    authtoken: "token",
    bearertoken: "token",
    registrationtoken: "token",
    authorization: "token",
    csrftoken: "token",
    xsrftoken: "token",
    // Sessions
    sessionid: "session",
    sessiondatakey: "session",
    sessionstate: "session",
    jsessionid: "session",
    phpsessid: "session",
    sessiontoken: "session",
    // Emails
    email: "email",
    mail: "email",
    emailaddress: "email",
    useremail: "email",
    loginhint: "email",
    // Usernames
    username: "username",
    jusername: "username",
    user: "username",
    login: "username",
    loginname: "username",
    userlogin: "username",
};

const SENSITIVE_HEADER_NAMES: Record<string, RedactionKind> = {
    authorization: "token",
    "proxy-authorization": "token",
    cookie: "cookie",
    "set-cookie": "cookie",
    "x-api-key": "secret",
    "x-auth-token": "token",
    "x-access-token": "token",
    "x-csrf-token": "token",
    "x-xsrf-token": "token",
};

const JWT_RE = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g;

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.([A-Za-z]{2,})/g;

// File-extension pseudo-TLDs that make `image@2x.png` look like an email.
const EMAIL_TLD_BLOCKLIST = new Set([
    "png",
    "jpg",
    "jpeg",
    "gif",
    "svg",
    "webp",
    "ico",
    "css",
    "js",
    "ts",
    "map",
    "json",
    "html",
    "woff",
    "woff2",
    "ttf",
    "min",
]);

function kindForKey(key: string): RedactionKind | undefined {
    return KEY_KINDS[normalizeKey(key)];
}

/** True when the value is already a mask from a previous pass. */
export function isRedactedValue(value: string): boolean {
    return LABEL_RE.test(value) || STARS_RE.test(value) || value.includes(PARTIAL_GAP) || MASKED_EMAIL_RE.test(value);
}

function starsMask(value: string): string {
    return "*".repeat(Math.min(value.length, STARS_MAX_LENGTH));
}

function partialMask(value: string): string {
    if (value.length < PARTIAL_MIN_LENGTH) {
        return starsMask(value);
    }

    const reveal = Math.min(PARTIAL_MAX_REVEAL_PER_SIDE, Math.floor(value.length / 4));
    return `${value.slice(0, reveal)}${PARTIAL_GAP}${value.slice(value.length - reveal)}`;
}

/** Parse CLI-style flag strings into RedactorOptions. Pure, shared by CLI and MCP. */
export function parseRedactorFlags(flags: { only?: string; skip?: string; mask?: string }): {
    options: RedactorOptions;
    errors: string[];
} {
    const errors: string[] = [];
    const options: RedactorOptions = {};

    const parseKinds = (raw: string, flag: string): RedactionKind[] =>
        raw
            .split(",")
            .map((k) => k.trim())
            .filter((k) => k.length > 0)
            .filter((k) => {
                if (!REDACTION_KINDS.includes(k as RedactionKind)) {
                    errors.push(`${flag}: unknown kind "${k}" (valid: ${REDACTION_KINDS.join(", ")})`);
                    return false;
                }
                return true;
            }) as RedactionKind[];

    if (flags.only) {
        options.only = parseKinds(flags.only, "--only");
    }

    if (flags.skip) {
        options.skip = parseKinds(flags.skip, "--skip");
    }

    if (flags.mask) {
        const styles: Partial<Record<RedactionKind, MaskStyle>> = {};
        for (const pair of flags.mask.split(",")) {
            const [kind, style] = pair.split("=").map((s) => s.trim());
            if (!REDACTION_KINDS.includes(kind as RedactionKind)) {
                errors.push(`--mask: unknown kind "${kind}" (valid: ${REDACTION_KINDS.join(", ")})`);
                continue;
            }

            if (!MASK_STYLES.includes(style as MaskStyle)) {
                errors.push(`--mask: unknown style "${style}" for "${kind}" (valid: ${MASK_STYLES.join(", ")})`);
                continue;
            }

            styles[kind as RedactionKind] = style as MaskStyle;
        }
        options.styles = styles;
    }

    return { options, errors };
}

class ChangeCollector {
    changes = new Map<string, RedactionChange>();
    entryIndex = 0;

    record(location: string, kind: RedactionKind, count = 1): void {
        const key = `${this.entryIndex}|${location}|${kind}`;
        const existing = this.changes.get(key);
        if (existing) {
            existing.count += count;
        } else {
            this.changes.set(key, { entryIndex: this.entryIndex, location, kind, count });
        }
    }
}

class Redactor {
    private collector = new ChangeCollector();
    private skippedNotes: string[] = [];
    private styles: Record<RedactionKind, MaskStyle>;
    private active: Set<RedactionKind>;

    constructor(options: RedactorOptions) {
        this.styles = { ...DEFAULT_STYLES, ...options.styles };

        if (options.only && options.only.length > 0) {
            this.active = new Set(options.only);
        } else {
            this.active = new Set(REDACTION_KINDS);
            for (const kind of options.skip ?? []) {
                this.active.delete(kind);
            }
        }

        for (const kind of REDACTION_KINDS) {
            if (this.styles[kind] === "keep") {
                this.active.delete(kind);
            }
        }
    }

    get changes(): RedactionChange[] {
        return [...this.collector.changes.values()];
    }

    get skipped(): string[] {
        return this.skippedNotes;
    }

    private isActive(kind: RedactionKind): boolean {
        return this.active.has(kind);
    }

    /** Mask a whole value known to be of `kind`. Returns the input when inactive/already masked. */
    private mask(value: string, kind: RedactionKind): string {
        if (!this.isActive(kind) || value.length === 0 || isRedactedValue(value)) {
            return value;
        }

        const style = this.styles[kind];
        if (style === "label") {
            return `[REDACTED:${kind}]`;
        }

        if (style === "stars") {
            return starsMask(value);
        }

        // partial: emails keep their domain; everything else keeps head+tail
        const at = value.indexOf("@");
        if (kind === "email" && at > 0) {
            return `${starsMask(value.slice(0, at))}${value.slice(at)}`;
        }

        return partialMask(value);
    }

    /** Mask + record under `location` when the value actually changed. */
    private maskKeyed(value: string, kind: RedactionKind, location: string): string {
        const masked = this.mask(value, kind);
        if (masked !== value) {
            this.collector.record(location, kind);
        }

        return masked;
    }

    /** Redact unmistakable value shapes (JWT always; email only when allowed). */
    private redactValuePatterns(value: string, location: string, options: { emails: boolean }): string {
        let result = value;

        if (this.isActive("jwt")) {
            let jwtCount = 0;
            result = result.replace(JWT_RE, (match) => {
                const masked = this.mask(match, "jwt");
                if (masked !== match) {
                    jwtCount++;
                }
                return masked;
            });
            if (jwtCount > 0) {
                this.collector.record(location, "jwt", jwtCount);
            }
        }

        if (options.emails && this.isActive("email")) {
            let emailCount = 0;
            result = result.replace(EMAIL_RE, (match, tld: string) => {
                if (EMAIL_TLD_BLOCKLIST.has(tld.toLowerCase())) {
                    return match;
                }

                const masked = this.mask(match, "email");
                if (masked !== match) {
                    emailCount++;
                }
                return masked;
            });
            if (emailCount > 0) {
                this.collector.record(location, "email", emailCount);
            }
        }

        return result;
    }

    private walkJson(node: unknown, path: string): unknown {
        if (Array.isArray(node)) {
            return node.map((item, i) => this.walkJson(item, `${path}[${i}]`));
        }

        if (node && typeof node === "object") {
            const result: Record<string, unknown> = {};
            for (const [key, value] of Object.entries(node)) {
                const childPath = `${path}.${key}`;
                const kind = kindForKey(key);

                if (kind && (typeof value === "string" || typeof value === "number")) {
                    result[key] = this.maskKeyed(String(value), kind, childPath);
                } else if (typeof value === "string") {
                    result[key] = this.redactValuePatterns(value, childPath, { emails: true });
                } else {
                    result[key] = this.walkJson(value, childPath);
                }
            }
            return result;
        }

        return node;
    }

    private redactJsonText(text: string, location: string): string | null {
        let parsed: unknown;
        try {
            parsed = SafeJSON.parse(text, { strict: true });
        } catch {
            // Not valid JSON despite the mime type; caller falls back to pattern pass.
            return null;
        }

        if (parsed === null || typeof parsed !== "object") {
            return null;
        }

        const redacted = this.walkJson(parsed, `${location} $`);
        return SafeJSON.stringify(redacted, { strict: true });
    }

    /** Redact urlencoded pairs, preserving untouched pairs byte-for-byte. */
    private redactFormText(text: string, location: string): string {
        return text
            .split("&")
            .map((pair) => {
                const eq = pair.indexOf("=");
                if (eq === -1) {
                    return pair;
                }

                const rawName = pair.slice(0, eq);
                const rawValue = pair.slice(eq + 1);
                let name = rawName;
                try {
                    name = decodeURIComponent(rawName.replace(/\+/g, " "));
                } catch {
                    // Malformed percent-encoding; match against the raw name.
                }

                let decoded: string | null;
                try {
                    decoded = decodeURIComponent(rawValue.replace(/\+/g, " "));
                } catch {
                    decoded = null;
                }

                const kind = kindForKey(name);
                if (kind) {
                    const value = decoded ?? rawValue;
                    const masked = this.maskKeyed(value, kind, `${location}:${name}`);
                    if (masked !== value) {
                        return `${rawName}=${encodeURIComponent(masked)}`;
                    }

                    return pair;
                }

                if (decoded === null) {
                    return pair;
                }

                const redacted = this.redactValuePatterns(decoded, `${location}:${name}`, { emails: true });
                if (redacted !== decoded) {
                    return `${rawName}=${encodeURIComponent(redacted)}`;
                }

                return pair;
            })
            .join("&");
    }

    /** Redact query values inside a URL string, preserving untouched params. */
    private redactUrl(url: string, location: string): string {
        const qIndex = url.indexOf("?");
        const base = qIndex === -1 ? url : url.slice(0, qIndex);
        const query = qIndex === -1 ? "" : url.slice(qIndex + 1);

        const redactedBase = this.redactValuePatterns(base, location, { emails: false });
        if (query === "") {
            return redactedBase;
        }

        // Fragment can carry OAuth implicit-flow tokens; treat it like a query.
        return `${redactedBase}?${this.redactFormText(query, location)}`;
    }

    private redactHeaders(headers: HarHeader[], location: string): void {
        for (const header of headers) {
            const lower = header.name.toLowerCase();
            const kind = SENSITIVE_HEADER_NAMES[lower];

            if (isRedactedValue(header.value)) {
                continue;
            }

            if (lower === "authorization" || lower === "proxy-authorization") {
                const schemeMatch = header.value.match(/^(\w+)\s+(\S.*)$/);
                if (schemeMatch) {
                    const masked = this.mask(schemeMatch[2], "token");
                    if (masked !== schemeMatch[2]) {
                        this.collector.record(`${location}.${header.name}`, "token");
                        header.value = `${schemeMatch[1]} ${masked}`;
                    }
                } else {
                    header.value = this.maskKeyed(header.value, "token", `${location}.${header.name}`);
                }
            } else if (lower === "set-cookie") {
                // Keep cookie name + attributes; redact only the value segment.
                header.value = header.value
                    .split("\n")
                    .map((line) => {
                        const eq = line.indexOf("=");
                        if (eq === -1) {
                            return line;
                        }

                        const semi = line.indexOf(";", eq);
                        const value = semi === -1 ? line.slice(eq + 1) : line.slice(eq + 1, semi);
                        const masked = this.mask(value, "cookie");
                        if (masked === value) {
                            return line;
                        }

                        this.collector.record(`${location}.set-cookie:${line.slice(0, eq).trim()}`, "cookie");
                        return `${line.slice(0, eq + 1)}${masked}${semi === -1 ? "" : line.slice(semi)}`;
                    })
                    .join("\n");
            } else if (lower === "cookie") {
                let replaced = 0;
                header.value = header.value
                    .split(";")
                    .map((part) => {
                        const eq = part.indexOf("=");
                        if (eq === -1) {
                            return part;
                        }

                        const value = part.slice(eq + 1).trim();
                        const masked = this.mask(value, "cookie");
                        if (masked === value) {
                            return part;
                        }

                        replaced++;
                        return `${part.slice(0, eq + 1)}${masked}`;
                    })
                    .join(";");
                if (replaced > 0) {
                    this.collector.record(`${location}.${header.name}`, "cookie", replaced);
                }
            } else if (kind) {
                header.value = this.maskKeyed(header.value, kind, `${location}.${header.name}`);
            } else if (lower === "location" || lower === "referer") {
                header.value = this.redactUrl(header.value, `${location}.${header.name}`);
            } else {
                header.value = this.redactValuePatterns(header.value, `${location}.${header.name}`, {
                    emails: false,
                });
            }
        }
    }

    private redactBodyText(text: string, mimeType: string, location: string): string {
        const normalizedMime = mimeType.split(";")[0].trim().toLowerCase();

        if (normalizedMime.includes("json")) {
            const structured = this.redactJsonText(text, location);
            if (structured !== null) {
                return structured;
            }
        }

        if (normalizedMime === "application/x-www-form-urlencoded") {
            return this.redactFormText(text, location);
        }

        // Raw/unknown bodies: JWTs only; email matching in HTML would scrub
        // legitimate page content (contact addresses, mailto links).
        return this.redactValuePatterns(text, location, { emails: false });
    }

    /** Serialize-scan-scrub for JWTs hiding in fields the walkers don't know about. */
    private jwtCatchAll<T>(node: T, location: string): T {
        if (!this.isActive("jwt")) {
            return node;
        }

        const serialized = SafeJSON.stringify(node, { strict: true });
        let count = 0;
        const scrubbed = serialized.replace(JWT_RE, (match) => {
            const masked = this.mask(match, "jwt");
            if (masked !== match) {
                count++;
            }
            return masked;
        });

        if (count === 0) {
            return node;
        }

        this.collector.record(location, "jwt", count);
        return SafeJSON.parse(scrubbed, { strict: true }) as T;
    }

    redactEntryInPlace(entry: HarEntry, index: number): void {
        this.collector.entryIndex = index;

        entry.request.url = this.redactUrl(entry.request.url, "request.url");
        this.redactHeaders(entry.request.headers, "request.headers");
        this.redactHeaders(entry.response.headers, "response.headers");

        for (const param of entry.request.queryString) {
            const kind = kindForKey(param.name);
            if (kind && param.value.length > 0) {
                param.value = this.maskKeyed(param.value, kind, `request.queryString:${param.name}`);
            } else {
                param.value = this.redactValuePatterns(param.value, `request.queryString:${param.name}`, {
                    emails: true,
                });
            }
        }

        for (const cookie of [...entry.request.cookies, ...entry.response.cookies]) {
            cookie.value = this.maskKeyed(cookie.value, "cookie", `cookies:${cookie.name}`);
        }

        const postData = entry.request.postData;
        if (postData) {
            if (postData.text) {
                postData.text = this.redactBodyText(postData.text, postData.mimeType ?? "", "request.body");
            }

            for (const param of postData.params ?? []) {
                if (param.value === undefined || param.value.length === 0) {
                    continue;
                }

                const kind = kindForKey(param.name);
                if (kind) {
                    param.value = this.maskKeyed(param.value, kind, `request.params:${param.name}`);
                } else {
                    param.value = this.redactValuePatterns(param.value, `request.params:${param.name}`, {
                        emails: true,
                    });
                }
            }
        }

        const content = entry.response.content;
        if (content.text) {
            if (content.encoding === "base64") {
                this.skippedNotes.push(`entry ${index}: base64 response body (${content.mimeType}) not scanned`);
            } else {
                content.text = this.redactBodyText(content.text, content.mimeType ?? "", "response.body");
            }
        }

        if (entry.response.redirectURL) {
            entry.response.redirectURL = this.redactUrl(entry.response.redirectURL, "response.redirectURL");
        }

        Object.assign(entry, this.jwtCatchAll(entry, "entry (catch-all)"));
    }

    redactPages(har: HarFile): void {
        // Pages carry the visited URL in `title`; OAuth flows put id_token_hint /
        // login_hint right there.
        this.collector.entryIndex = -1;
        for (const [i, page] of (har.log.pages ?? []).entries()) {
            if (page.title && /^https?:/i.test(page.title)) {
                page.title = this.redactUrl(page.title, `log.pages[${i}].title`);
            } else if (page.title) {
                page.title = this.redactValuePatterns(page.title, `log.pages[${i}].title`, { emails: false });
            }
        }
    }

    finalSweep(har: HarFile): HarFile {
        this.collector.entryIndex = -1;
        return this.jwtCatchAll(har, "log (catch-all)");
    }
}

/**
 * Redact a HAR file. Returns a deep-copied redacted HAR plus a value-free
 * change report. Idempotent: running it on its own output yields zero changes.
 */
export function redactHar(har: HarFile, options: RedactorOptions = {}): RedactionResult {
    const clone = SafeJSON.parse(SafeJSON.stringify(har, { strict: true }), {
        strict: true,
    }) as HarFile;
    const redactor = new Redactor(options);

    clone.log.entries.forEach((entry, index) => {
        redactor.redactEntryInPlace(entry, index);
    });

    redactor.redactPages(clone);
    const swept = redactor.finalSweep(clone);

    return { har: swept, changes: redactor.changes, skipped: redactor.skipped };
}

/** Redact a single entry (shared by `export --sanitize`). */
export function redactEntry(
    entry: HarEntry,
    index = 0,
    options: RedactorOptions = {}
): { entry: HarEntry; changes: RedactionChange[] } {
    const clone = SafeJSON.parse(SafeJSON.stringify(entry, { strict: true }), {
        strict: true,
    }) as HarEntry;
    const redactor = new Redactor(options);
    redactor.redactEntryInPlace(clone, index);
    return { entry: clone, changes: redactor.changes };
}
