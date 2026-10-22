/**
 * Masks secret-shaped values in free text before it is stored. Pattern-based and conservative: it
 * covers the credential formats that show up in files, logs and command output on this kind of
 * machine (provider API keys, forge and chat tokens, JWTs, private keys, credentials in URLs, and
 * `password: x` / `TOKEN=x` assignments, cookie headers, and the values in a browser's saved cookies). A miss is possible, which is why a transclusion is also
 * size-capped and the original token is kept beside the resolved text.
 */

const MASK = "[redacted]";

const WHOLE_MATCH: RegExp[] = [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
    /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g,
    /\bgithub_pat_[A-Za-z0-9_]{40,}\b/g,
    /\bglpat-[A-Za-z0-9_-]{20,}\b/g,
    /\bxox[abeoprs]-[A-Za-z0-9-]{10,}\b/g,
    /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
    /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}\b/g,
    /\bxai-[A-Za-z0-9]{32,}\b/g,
    /\bAIza[0-9A-Za-z_-]{35}\b/g,
    // A JWT header is always `eyJ` (base64 of `{"`); its payload need not be, when it is itself encoded.
    /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
];

/** The first group is kept, the rest of the match is masked. */
const KEEP_PREFIX: RegExp[] = [
    /(\bBearer\s+)[A-Za-z0-9._~+/-]{12,}=*/gi,
    /(\b[a-z][a-z0-9+.-]*:\/\/[^:\s/@]+:)[^@\s/]+(?=@)/gi,
    /(\b(?:Set-)?Cookie:[ \t]*)[^\r\n]+/gi,
    // A value only counts when it looks like a credential (16+ key characters, a digit among them), so
    // code such as `refreshToken: string` or `token = readToken()` in an excerpt stays readable. A name may follow
    // a diff row's `+` or `-` (`+TOKEN=…` in a patch of a .env file).
    /((?:^[+-]?|[\s"'{,])[\w.-]*(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key)["']?\s*[:=]\s*["']?)(?=[A-Za-z0-9_+/=.-]*\d)[A-Za-z0-9_+/=.-]{16,}/gim,
];

/**
 * A quoted literal assigned to a credential name is a secret whatever its characters: `PASSWORD="A1bc defg hij"`
 * has spaces the run-of-key-characters rule above cannot cross. Only a literal (8+ characters, no `$` expansion);
 * `token = readToken()` and `password: string` stay readable.
 */
const QUOTED_CREDENTIAL =
    /((?:^[+-]?|[\s{,(])["']?[\w.-]*(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key)["']?\s*[:=]\s*)(["'])(?!\[redacted\])([^"'$\n]{8,})\2/gim;

/** A browser's saved login (Playwright `storageState`, a cookie jar): every cookie and storage value is a session. */
const COOKIE_JAR = /"(?:cookies|localStorage|httpOnly|sameSite)"\s*:/;
const JAR_VALUE = /("value"\s*:\s*")(?:[^"\\\n]|\\.)*(?=")/g;

/** Whether a text is (part of) a saved browser login, whose every `"value"` is a session secret. */
export function looksLikeCookieJar(text: string): boolean {
    return COOKIE_JAR.test(text);
}

/**
 * `cookieJar: true` masks every `"value"` even when `text` alone shows no jar marker: a diff hunk of a storage-state
 * file can hold a changed cookie value with none of `cookies`, `httpOnly` or `sameSite` in its context lines.
 */
export function redactSecretsInText(text: string, options: { cookieJar?: boolean } = {}): string {
    let result =
        options.cookieJar || COOKIE_JAR.test(text)
            ? text.replace(JAR_VALUE, (_match, prefix: string) => `${prefix}${MASK}`)
            : text;

    for (const pattern of WHOLE_MATCH) {
        result = result.replace(pattern, MASK);
    }

    // The whole quoted literal first: the key-character rule below would mask only its first word and leave the rest.
    result = result.replace(
        QUOTED_CREDENTIAL,
        (_match, prefix: string, quote: string) => `${prefix}${quote}${MASK}${quote}`
    );

    for (const pattern of KEEP_PREFIX) {
        result = result.replace(pattern, (_match, prefix: string) => `${prefix}${MASK}`);
    }

    return result;
}
