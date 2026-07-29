import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { logger } from "@genesiscz/utils/logger";
import type { Storage } from "@genesiscz/utils/storage";

/**
 * app.timelyapp.com (memories / suggested entries / entries) authenticates with
 * the browser session cookie only. It rejects OAuth bearer tokens, so the whole
 * Cookie header is stored and sent with those requests.
 *
 * The value is a credential: never log it, never print it back. It lives in its
 * own 0600 file rather than in config.json, because Storage rewrites the config
 * through a fresh umask-created temp file plus rename on every write. That
 * replaces the inode, so a mode set on the config never survives the next
 * unrelated update (a token refresh, an account switch).
 */
const COOKIE_FILE = "cookie";
const COOKIE_FILE_MODE = 0o600;
const COOKIE_UPDATED_KEY = "cookieUpdatedAt";
/** Where the cookie used to be stored, before it got its own file. */
const LEGACY_COOKIE_KEY = "cookie";

export interface SaveCookieResult {
    /** Absolute path the cookie was written to. */
    path: string;
    /** True only when the file is verifiably owner-only on disk, so callers never over-promise. */
    ownerOnly: boolean;
}

function cookiePath(storage: Storage): string {
    return join(storage.getBaseDir(), COOKIE_FILE);
}

export async function readStoredCookie(storage: Storage): Promise<string | undefined> {
    const path = cookiePath(storage);

    if (existsSync(path)) {
        const cookie = readFileSync(path, "utf-8").trim();
        return cookie ? cookie : undefined;
    }

    return migrateLegacyCookie(storage);
}

export async function saveCookie(storage: Storage, cookie: string): Promise<SaveCookieResult> {
    const path = cookiePath(storage);
    const ownerOnly = writeCookieFile(path, cookie);
    await storage.setConfigValue(COOKIE_UPDATED_KEY, Math.floor(Date.now() / 1000));

    return { path, ownerOnly };
}

/**
 * Write the credential and report whether the result is genuinely owner-only.
 * `mode` on writeFileSync applies only when the file is created, so an existing
 * world-readable file needs the explicit chmod; the stat afterwards is what makes
 * the answer honest on filesystems that accept chmod and ignore it.
 */
function writeCookieFile(path: string, cookie: string): boolean {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, `${cookie}\n`, { encoding: "utf-8", mode: COOKIE_FILE_MODE });

    try {
        chmodSync(path, COOKIE_FILE_MODE);
        return (statSync(path).mode & 0o777) === COOKIE_FILE_MODE;
    } catch (err) {
        logger.warn({ err, path }, "Could not restrict the Timely cookie file to owner-only (0600)");
        return false;
    }
}

/** Move a cookie left in config.json by an earlier build into its own 0600 file, once. */
async function migrateLegacyCookie(storage: Storage): Promise<string | undefined> {
    const legacy = (await storage.getConfigValue<string>(LEGACY_COOKIE_KEY))?.trim();
    if (!legacy) {
        return undefined;
    }

    writeCookieFile(cookiePath(storage), legacy);
    await storage.atomicConfigUpdate<Record<string, unknown>>((config) => {
        delete config[LEGACY_COOKIE_KEY];
    });
    logger.info("Moved the stored Timely cookie out of config.json into its own owner-only file.");

    return legacy;
}

/** Strip a pasted "Cookie: " prefix and surrounding whitespace/quotes. */
export function normalizeCookieHeader(pasted: string): string {
    return pasted
        .trim()
        .replace(/^cookie:\s*/i, "")
        .replace(/^["']|["']$/g, "")
        .trim();
}

/** RFC 6265 cookie-name token characters. Deliberately excludes `/ : ? & @`, so a URL never passes. */
const COOKIE_PAIR = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+=[^;]*$/;

/**
 * True when every `;`-separated chunk is a `name=value` pair. Used to reject the
 * other quoted arguments of a curl command (the URL, `accept: application/json`)
 * without having to understand curl's grammar.
 */
export function looksLikeCookiePairs(value: string): boolean {
    const pairs = value
        .split(";")
        .map((pair) => pair.trim())
        .filter(Boolean);

    if (pairs.length === 0) {
        return false;
    }

    return pairs.every((pair) => COOKIE_PAIR.test(pair));
}

/**
 * Split shell source into argv the way a shell would, so a pasted
 * "Copy as cURL" survives whichever quoting the browser chose. Handles single
 * quotes, double quotes, bash's `$'...'` (Chrome emits it when a header value
 * contains a quote), backslash escapes and backslash-newline continuations.
 *
 * Inside `$'...'` a backslash escapes the next character literally. The ANSI-C
 * control escapes (`\n`, `\t`, `\xNN`) are deliberately left untranslated: a
 * Cookie header cannot legally carry those bytes, so decoding them would only
 * turn a malformed paste into a header value that looks valid.
 */
export function shellTokens(input: string): string[] {
    const tokens: string[] = [];
    let current = "";
    let started = false;
    let quote: "'" | '"' | null = null;
    let ansiC = false;

    for (let i = 0; i < input.length; i++) {
        const char = input[i];

        if (quote) {
            if (char === quote) {
                quote = null;
                ansiC = false;
                continue;
            }

            // Only "…" and $'…' process escapes; inside a plain '…' a backslash is
            // literal. Consuming the whole pair is what stops a trailing `\\` from
            // escaping the closing quote and swallowing the rest of the command.
            if (char === "\\" && i + 1 < input.length && (quote === '"' || ansiC)) {
                current += input[i + 1];
                i++;
                continue;
            }

            current += char;
            continue;
        }

        if (char === "$" && (input[i + 1] === "'" || input[i + 1] === '"')) {
            quote = input[i + 1] as "'" | '"';
            ansiC = quote === "'";
            started = true;
            i++;
            continue;
        }

        if (char === "'" || char === '"') {
            quote = char;
            started = true;
            continue;
        }

        if (char === "\\" && i + 1 < input.length) {
            if (input[i + 1] !== "\n") {
                current += input[i + 1];
                started = true;
            }

            i++;
            continue;
        }

        if (/\s/.test(char)) {
            if (started) {
                tokens.push(current);
                current = "";
                started = false;
            }

            continue;
        }

        current += char;
        started = true;
    }

    if (started) {
        tokens.push(current);
    }

    return tokens;
}

export type CookieSource = "curl-cookie-flag" | "curl-header-flag" | "header-line" | "raw-pairs";

export interface ExtractedCookie {
    cookie: string;
    source: CookieSource;
}

/**
 * Pull the Cookie header out of whatever the user pasted. Accepts, in order of
 * preference: a whole `curl` command (`-b` / `--cookie`, or `-H 'cookie: …'`),
 * a bare `Cookie: name=v; …` header line, or a bare `name=v; …` string.
 *
 * Returns undefined when nothing in the input parses as cookie pairs, so the
 * caller can ask again instead of probing Timely with garbage.
 */
export function extractCookie(input: string): ExtractedCookie | undefined {
    if (!input?.trim()) {
        return undefined;
    }

    const tokens = shellTokens(input);
    for (let i = 0; i < tokens.length; i++) {
        const flag = tokens[i];
        const value = tokens[i + 1];
        if (value === undefined) {
            continue;
        }

        if (flag === "-b" || flag === "--cookie") {
            const cookie = normalizeCookieHeader(value);
            if (looksLikeCookiePairs(cookie)) {
                return { cookie, source: "curl-cookie-flag" };
            }
        }

        if ((flag === "-H" || flag === "--header") && /^\s*cookie\s*:/i.test(value)) {
            const cookie = normalizeCookieHeader(value);
            if (looksLikeCookiePairs(cookie)) {
                return { cookie, source: "curl-header-flag" };
            }
        }
    }

    for (const line of input.split("\n")) {
        if (!/^\s*cookie\s*:/i.test(line)) {
            continue;
        }

        const cookie = normalizeCookieHeader(line.replace(/\\\s*$/, ""));
        if (looksLikeCookiePairs(cookie)) {
            return { cookie, source: "header-line" };
        }
    }

    for (const line of input.split("\n")) {
        const cookie = normalizeCookieHeader(line);
        if (looksLikeCookiePairs(cookie)) {
            return { cookie, source: "raw-pairs" };
        }
    }

    return undefined;
}

/** Human label for a cookie without revealing any value: names and count only. */
export function describeCookie(cookie: string): string {
    const names = cookie
        .split(";")
        .map((pair) => pair.trim().split("=")[0])
        .filter(Boolean);

    const shown = names.slice(0, 4).join(", ");
    const rest = names.length > 4 ? `, +${names.length - 4} more` : "";
    return `${names.length} cookie${names.length === 1 ? "" : "s"}: ${shown}${rest}`;
}

/**
 * Headers for an app.timelyapp.com request. The bearer is kept because it is
 * harmless and still identifies the caller; the cookie is what actually works.
 */
export function webSessionHeaders(options: { accessToken: string; cookie?: string }): Record<string, string> {
    const headers: Record<string, string> = {
        accept: "application/json",
        Authorization: `Bearer ${options.accessToken}`,
    };

    if (options.cookie) {
        headers.Cookie = options.cookie;
    }

    return headers;
}
