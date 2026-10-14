import { GATEWAY_HEADER, REDACTED } from "./constants.ts";

const HEADER_KEYS = new Set(["authorization", GATEWAY_HEADER.toLowerCase(), "x-api-key", "proxy-authorization"]);

const SECRET_NAME =
    "[A-Za-z0-9_-]*(?:token|secret|password|passwd|api[_-]?key|access[_-]?key|private[_-]?key|auth[_-]?config)[A-Za-z0-9_-]*";

const SECRET_KEY = `(?:${[...HEADER_KEYS].map((key) => key.replace(/[-]/g, "\\-")).join("|")}|${SECRET_NAME})`;

/**
 * Secrets that ride in a server's `args` rather than under a secret-looking key: `--access-token=<value>`, a
 * `"--access-token", "<value>"` pair, and a bare token whose prefix names its issuer. On 2026-10-13 a sync diff
 * printed two Sentry tokens (`--access-token=sntryu_…`) and a Supabase token (`sbp_…`) in clear, and the logger
 * copied them into the day log.
 */
const TOKEN_PREFIX =
    "(?:sbp_|sntryu_|sntrys_|ghp_|gho_|ghu_|ghs_|github_pat_|glpat-|xai-|sk-ant-|sk-proj-|sk-|xox[abpr]-|AIza)";
const SERIALIZED_STRING = `(?:"(?:[^"\\\\\\n]|\\\\.)*"|'[^'\\n]*')`;
const SECRET_FLAG_WITH_VALUE = new RegExp(
    `("--?${SECRET_NAME}=)(?:[^"\\\\\\n]|\\\\.)*"|('--?${SECRET_NAME}=)[^'\\n]*'`,
    "gi"
);
const SECRET_FLAG_THEN_VALUE = new RegExp(`(["']--?${SECRET_NAME}["']\\s*,\\s*)(${SERIALIZED_STRING})`, "gi");
const PREFIXED_TOKEN = new RegExp(`(["'])${TOKEN_PREFIX}[A-Za-z0-9_-]{8,}\\1`, "g");
const SECRET_FLAG = new RegExp(`^--?${SECRET_NAME}$`, "i");
const SECRET_FLAG_ASSIGNMENT = new RegExp(`^(--?${SECRET_NAME}=).+$`, "i");
const BARE_PREFIXED_TOKEN = new RegExp(`^${TOKEN_PREFIX}[A-Za-z0-9_-]{8,}$`);

/**
 * `"<key>": "<value>"` (JSON) or `<key> = "<value>"` / `<key> = '<value>'` (TOML) where the key is a
 * credential header or an env name that reads like one (`OPENAI_API_KEY`, `DB_PASSWORD`,
 * `DOCKER_AUTH_CONFIG`). A double-quoted value runs to its closing quote past escaped quotes
 * (`\"`), so no tail of the secret survives; a TOML literal string ends at the next `'`. A TOML
 * multiline string (`"""` or `'''`) is matched first and redacted whole, across its lines; a basic one honours
 * escapes, so an escaped quote inside it never reads as its closing delimiter.
 */
const SECRET_VALUE_IN_TEXT = new RegExp(
    `(${SECRET_KEY}["']?\\s*[:=]\\s*)(?:"""(?:[^"\\\\]|\\\\[\\s\\S]|"(?!""))*"""|'''[\\s\\S]*?'''|"(?:[^"\\\\\\n]|\\\\.)*"|'[^'\\n]*')`,
    "gi"
);

/**
 * Redact credential values inside a serialized harness config (JSON or TOML): auth headers and
 * secret-looking env entries. For text that is printed or logged, such as a config diff: the
 * logger writes it to the day log too.
 */
export function redactConfigText(text: string): string {
    return text
        .replace(SECRET_VALUE_IN_TEXT, (match: string, prefix: string) => {
            const value = match.slice(prefix.length);
            const quote = value.startsWith('"""') || value.startsWith("'''") ? value.slice(0, 3) : value.slice(0, 1);
            return `${prefix}${quote}${REDACTED}${quote}`;
        })
        .replace(SECRET_FLAG_WITH_VALUE, (_match, doublePrefix: string, singlePrefix: string) => {
            const prefix = doublePrefix ?? singlePrefix;
            return `${prefix}${REDACTED}${prefix[0]}`;
        })
        .replace(
            SECRET_FLAG_THEN_VALUE,
            (_match, prefix: string, value: string) => `${prefix}${value[0]}${REDACTED}${value[0]}`
        )
        .replace(PREFIXED_TOKEN, `$1${REDACTED}$1`);
}

/** One `args` list with its secrets hidden: a secret flag's value, inline or in the next element, and bare tokens. */
function redactArgs(items: unknown[]): unknown[] {
    return items.map((item, index) => {
        if (typeof item !== "string") {
            return item;
        }

        const previous = items[index - 1];

        if (typeof previous === "string" && SECRET_FLAG.test(previous)) {
            return REDACTED;
        }

        const assignment = item.match(SECRET_FLAG_ASSIGNMENT);

        if (assignment) {
            return `${assignment[1]}${REDACTED}`;
        }

        return BARE_PREFIXED_TOKEN.test(item) ? REDACTED : item;
    });
}

export function redactMcpValue<T>(value: T): T {
    return walk(value, undefined) as T;
}

/**
 * Redact every value of a connection's headers, regardless of key name.
 *
 * `redactMcpValue`'s key-pattern heuristic (`authorization`, `x-api-key`, `/token|secret/`,
 * ...) is a good default for a whole config object, but a server's own `headers` block can
 * name a credential under any header a remote API happens to require. A caller printing a
 * connection to a PUBLIC surface (`list --json` without `internal`) must not gamble on the
 * key naming convention: every header value is a secret until a caller proves it is about to
 * dial the connection and needs the real thing.
 */
export function redactHeaderValues(headers: Record<string, string>): Record<string, string> {
    return Object.fromEntries(Object.keys(headers).map((key) => [key, REDACTED]));
}

/** RFC 6749 §5.2 plus the RFC 8628 additions. Nothing else is a safe thing to echo. */
const OAUTH_ERROR_CODES = new Set([
    "invalid_request",
    "invalid_client",
    "invalid_grant",
    "unauthorized_client",
    "unsupported_grant_type",
    "invalid_scope",
    "invalid_target",
    "access_denied",
    "expired_token",
    "authorization_pending",
    "slow_down",
    "server_error",
    "temporarily_unavailable",
]);

/**
 * A bounded, non-secret label for a failed token-endpoint response.
 *
 * The raw body is never it. That body is persisted into auth-status.json and printed to
 * the terminal, and a server that answers a token request with something unexpected —
 * an echoed Authorization header, a debug dump, a signed assertion — puts a credential
 * in both places. A registered error code is a closed vocabulary, so it is safe; a
 * status line is safe; anything else collapses to the status alone.
 */
export function safeTokenErrorCode(error: unknown, status: number): string {
    if (typeof error === "string" && OAUTH_ERROR_CODES.has(error)) {
        return error;
    }

    return `HTTP ${status}`;
}

function walk(value: unknown, key: string | undefined): unknown {
    if (Array.isArray(value)) {
        return redactArgs(value).map((item) => walk(item, key));
    }

    if (value && typeof value === "object") {
        const out: Record<string, unknown> = {};

        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
            out[k] = walk(v, k);
        }

        return out;
    }

    if (typeof value === "string" && value.length > 0 && key && HEADER_KEYS.has(key.toLowerCase())) {
        return REDACTED;
    }

    if (typeof value === "string" && value.length > 0 && key && /token|secret|password|api[-_]?key/i.test(key)) {
        return REDACTED;
    }

    return value;
}
