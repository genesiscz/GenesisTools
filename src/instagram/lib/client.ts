import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { RateLimiter } from "./rate-limiter";
import { type AuthMode, InstagramError, type InstagramErrorKind } from "./types";

const { log } = logger.scoped("instagram:client");

/**
 * Public web app id. Stable and hardcoded across six independent repos, unlike the
 * mobile ids. We stay on the WEB surface exclusively — a browser `sessionid` is
 * documented by instagrapi as unreliable against the private mobile API
 * (`i.instagram.com`), where it can be rejected with `login_required` or
 * invalidated server-side. Since the cookie comes from the user's browser, the
 * mobile API is the wrong surface for it no matter how convenient its responses are.
 */
const WEB_APP_ID = "936619743392459";

/**
 * Drifts across Instagram builds (359341 / 129477 / 198387 all observed), so its
 * presence matters more than its value. Hardcoding one exact value would itself be
 * a fingerprint once it goes stale.
 */
const ASBD_ID = "129477";

const WEB_BASE = "https://www.instagram.com";

const WEB_USER_AGENT =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/** Terminal responses Instagram gives when it has decided something about the account. */
const CHECKPOINT_MARKERS = ["checkpoint_required", "challenge_required"] as const;
/** `"spam"` keeps its quotes: it is a JSON key here, and a bare word in bios. */
const FEEDBACK_MARKERS = ['"spam"', "feedback_required"] as const;
const IP_BLOCK_MARKERS = ["sentry_block", "rate_limit_error"] as const;
/** Arrives as 401 + `require_login: true`, so it must be matched before login_required. */
const PLEASE_WAIT_MARKERS = ["please wait a few minutes", "wait a few minutes"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

/**
 * Instagram's failure envelope, and the gate every marker scan sits behind.
 *
 * The markers are ordinary English otherwise: a profile whose biography reads
 * "no spam pls" or "please wait a few minutes, posting soon" comes back from
 * `web_profile_info` as a perfectly good HTTP 200, and scanning that body for
 * substrings turns a working account into a fabricated enforcement error. A
 * marker only means what it says inside a response Instagram itself failed.
 *
 * Read off the parsed object rather than the raw text, so it is the document's
 * OWN top-level verdict. A regex over the body would also accept a `status`
 * belonging to some nested object while the real top-level one said "ok".
 */
function hasFailEnvelope(parsed: unknown): boolean {
    return isRecord(parsed) && parsed.status === "fail";
}

export interface RequestOptions {
    sessionId?: string;
    /**
     * Paired with `sessionId`. Instagram expects the `x-csrftoken` header to match
     * the `csrftoken` cookie; a placeholder is a fingerprint mismatch, which the
     * research found triggers enforcement independently of request volume.
     */
    csrfToken?: string;
    label: string;
}

/**
 * The anonymous surface's contract, made structural instead of social.
 *
 * `fetchProfile` and `fetchPublicReelInfo` document that they take no session ON
 * PURPOSE, but `RequestOptions` alone cannot hold them to it: `getJson(path, {
 * label, sessionId: session?.sessionId })` typechecks perfectly, so one refactor
 * reintroduces exactly the instagrapi-style silent injection those comments
 * warn about. `sessionId?: never` turns that line into a compile error.
 */
export interface AnonymousRequestOptions {
    label: string;
    sessionId?: never;
    csrfToken?: never;
}

export interface InstagramResponse<T> {
    data: T;
    authMode: AuthMode;
}

/**
 * `x-ig-www-claim` is the one header that is genuinely load-bearing rather than
 * decorative: it starts as "0", and the server then hands back
 * `x-ig-set-www-claim`, which every subsequent request is expected to echo. Not
 * replaying it marks the client as not-a-browser across the whole session.
 *
 * Kept PER CREDENTIAL, because the claim is minted by Instagram against the
 * caller it answered. Echoing a claim issued to one caller on another's request
 * hands Instagram the link between them — which for the anonymous surface is
 * exactly the leak `fetchProfile` refuses a `sessionId` parameter to prevent.
 *
 * A map rather than one slot per auth mode, so correctness does not depend on
 * request ORDER. A single shared slot needs a "whose claim is in here?" variable
 * alongside it, and the window between switching that variable and reading the
 * slot is one `await` wide: with two sessions in flight, A's response can land
 * in the slot after B claimed ownership and before B builds its headers. Keying
 * by credential removes the window instead of narrowing it, because every
 * request reads and writes only its own entry.
 */
const wwwClaims = new Map<string, string>();

/**
 * Bounded by the number of distinct credentials a process actually uses — one or
 * two for the CLI. The cookie is hashed rather than used directly, since a live
 * credential has no business sitting in a module-level map key.
 */
function claimKeyFor(sessionId: string | undefined): string {
    return sessionId ? `session:${Bun.hash(sessionId)}` : "anonymous";
}

let limiter = new RateLimiter();

function buildHeaders(options: RequestOptions): Record<string, string> {
    const headers: Record<string, string> = {
        "x-ig-app-id": WEB_APP_ID,
        "x-asbd-id": ASBD_ID,
        "x-ig-www-claim": wwwClaims.get(claimKeyFor(options.sessionId)) ?? "0",
        "user-agent": WEB_USER_AGENT,
        accept: "*/*",
        "accept-language": "en-US,en;q=0.9",
        "x-requested-with": "XMLHttpRequest",
        referer: `${WEB_BASE}/`,
    };

    if (options.sessionId) {
        const cookieParts = [`sessionid=${options.sessionId}`];

        if (options.csrfToken) {
            cookieParts.push(`csrftoken=${options.csrfToken}`);
            headers["x-csrftoken"] = options.csrfToken;
        } else {
            log.warn(
                { label: options.label },
                "session without a csrftoken — header/cookie mismatch raises the enforcement risk"
            );
        }

        headers.cookie = cookieParts.join("; ");
    }

    return headers;
}

interface Classification {
    kind: InstagramErrorKind;
    challengeUrl?: string;
}

interface ClassifyInput {
    status: number;
    body: string;
    /** The already-parsed body, or `undefined` when it is not JSON at all. */
    parsed: unknown;
    authMode: AuthMode;
}

function classify({ status, body, parsed, authMode }: ClassifyInput): Classification | undefined {
    const lower = body.toLowerCase();
    // Instagram answers enforcement with 200 + a fail envelope as readily as with
    // a 4xx, so neither signal alone is enough to decide the body is worth scanning.
    const failed = status >= 400 || hasFailEnvelope(parsed);

    if (failed && CHECKPOINT_MARKERS.some((marker) => lower.includes(marker))) {
        const challengeUrl = extractChallengeUrl(body);

        // instaloader and instagrapi agree: "/suspended/" in the challenge URL is
        // a suspension, not a challenge you can clear by entering an SMS code.
        if (challengeUrl?.includes("/suspended/")) {
            return { kind: "suspended", challengeUrl };
        }

        return { kind: "checkpoint", challengeUrl };
    }

    if (failed && FEEDBACK_MARKERS.some((marker) => lower.includes(marker))) {
        return { kind: "feedback-required" };
    }

    if (failed && IP_BLOCK_MARKERS.some((marker) => lower.includes(marker))) {
        return { kind: "rate-limited" };
    }

    if (failed && PLEASE_WAIT_MARKERS.some((marker) => lower.includes(marker))) {
        return { kind: "please-wait" };
    }

    if (failed && (lower.includes("login_required") || lower.includes("logged_out"))) {
        return { kind: "session-required" };
    }

    if (status === 429) {
        return { kind: "rate-limited" };
    }

    if (status === 404) {
        return { kind: "not-found" };
    }

    // Instagram signals enforcement with 400 as often as 403, which a
    // status-code-only classifier misses entirely.
    if (status === 400 || status === 401 || status === 403) {
        return { kind: authMode === "session" ? "session-invalid" : "session-required" };
    }

    if (status >= 500) {
        return { kind: "network" };
    }

    return undefined;
}

/**
 * The only origin this client may speak to.
 *
 * `getJson` attaches `sessionid`, `csrftoken` and the www-claim to whatever it is
 * pointed at, so the destination is a credential boundary, not a convenience. An
 * absolute path from a caller (or a future redirect-following change) would
 * otherwise hand a live session to an arbitrary host, and an `http://` one would
 * put it on the wire in plaintext. Exact origin match rather than a suffix test:
 * the module's stated invariant is the WEB surface only, and `i.instagram.com`
 * is deliberately absent — adding the mobile surface should be a decision, not
 * something a wildcard grants silently.
 *
 * Compared as a full ORIGIN (scheme + host + port), not a hostname, because
 * `URL.hostname` drops the port: `https://www.instagram.com:4443/` is a
 * different origin that a hostname test waves through. Origin also subsumes the
 * scheme check, since `http://www.instagram.com` is its own origin. A default
 * `:443` normalises away, so the legitimate spelling is not rejected.
 */
const ALLOWED_ORIGINS: ReadonlySet<string> = new Set([new URL(WEB_BASE).origin]);

function resolveUrl(path: string, label: string): URL {
    let url: URL;

    // Resolving relative paths against WEB_BASE and absolute ones as-is, in one
    // step, also removes the `startsWith("http")` guess about which kind it is.
    try {
        url = new URL(path, WEB_BASE);
    } catch (error) {
        log.warn({ error, label }, "instagram request path does not resolve to a url");
        throw new InstagramError("network", `${label} has an unusable request path`);
    }

    if (!ALLOWED_ORIGINS.has(url.origin)) {
        log.warn({ label, origin: url.origin }, "refusing to attach credentials to a non-Instagram origin");
        throw new InstagramError("network", `${label} targeted ${url.origin}, which is not the Instagram web origin`);
    }

    // Userinfo survives the origin check — `https://evil:pw@www.instagram.com/`
    // has origin `https://www.instagram.com` — and `fetch` turns it into an
    // Authorization header. Nothing here should ever carry one.
    if (url.username !== "" || url.password !== "") {
        log.warn({ label, origin: url.origin }, "refusing a request url carrying userinfo");
        throw new InstagramError("network", `${label} carried credentials in the URL, which this client never sends`);
    }

    return url;
}

/** `undefined` for anything that is not JSON: the HTML shell, a truncated body. */
function tryParseJson(text: string, label: string): unknown {
    try {
        // Strict: this is an external HTTP response, and a lenient parser that
        // tolerates comments and trailing commas would accept bodies that Instagram
        // could not have sent, instead of routing them to the malformed path.
        return SafeJSON.parse(text, { strict: true });
    } catch (error) {
        log.debug({ error, label, bytes: text.length }, "instagram body did not parse as JSON");
        return undefined;
    }
}

function extractChallengeUrl(body: string): string | undefined {
    const match = body.match(/"url"\s*:\s*"([^"]*challenge[^"]*)"/i);
    return match ? match[1].replace(/\\\//g, "/") : undefined;
}

export async function getJson<T>(path: string, options: RequestOptions): Promise<InstagramResponse<T>> {
    // Before anything else: this is what decides whether the credentials below
    // are allowed to leave the machine at all.
    const url = resolveUrl(path, options.label);
    const authMode: AuthMode = options.sessionId ? "session" : "anonymous";
    // Captured per request, so a concurrent request for another credential can
    // neither be read from nor written to this one's claim.
    const claimKey = claimKeyFor(options.sessionId);

    await limiter.acquire(options.label);
    log.debug({ url: url.href, label: options.label, authMode, budgetUsed: limiter.used }, "instagram request");

    let response: Response;
    try {
        response = await fetch(url, { headers: buildHeaders(options), redirect: "manual" });
    } catch (error) {
        log.warn({ error, url: url.href, label: options.label }, "instagram request failed at the network layer");
        throw new InstagramError("network", `Request to ${options.label} failed: ${String(error)}`);
    }

    const setClaim = response.headers.get("x-ig-set-www-claim");
    if (setClaim) {
        log.debug({ label: options.label, authMode }, "captured a fresh x-ig-www-claim to replay on later requests");
        wwwClaims.set(claimKey, setClaim);
    }

    if (response.status >= 300 && response.status < 400) {
        log.warn({ status: response.status, label: options.label, authMode }, "instagram redirected to login");
        throw new InstagramError(
            authMode === "session" ? "session-invalid" : "session-required",
            `${options.label} redirected to login`,
            response.status
        );
    }

    const text = await response.text();
    // Parsed once, up front: the classifier needs the top-level `status` field to
    // tell an Instagram failure from a bio that merely reads like one, and the
    // success path needs the same object. `undefined` means "not JSON at all".
    const parsed = tryParseJson(text, options.label);
    const classification = classify({ status: response.status, body: text, parsed, authMode });

    if (classification) {
        log.warn(
            {
                status: response.status,
                label: options.label,
                authMode,
                kind: classification.kind,
                challengeUrl: classification.challengeUrl,
                bodyPreview: text.slice(0, 200),
            },
            "instagram request rejected"
        );
        throw new InstagramError(
            classification.kind,
            `${options.label} failed (${classification.kind})`,
            response.status,
            classification.challengeUrl
        );
    }

    if (!text.trimStart().startsWith("{")) {
        log.warn(
            { status: response.status, label: options.label, authMode, bytes: text.length },
            "instagram returned an HTML shell instead of JSON"
        );
        throw new InstagramError(
            authMode === "session" ? "session-invalid" : "session-required",
            `${options.label} returned HTML instead of JSON`,
            response.status
        );
    }

    // `startsWith("{")` above only proves it is not the HTML shell — a truncated
    // or half-written body still reaches here, and a raw SyntaxError escaping
    // would show the user a parser message for what is an Instagram problem.
    // Nothing that opens with `{` can parse TO undefined, so the sentinel is safe.
    if (parsed === undefined) {
        log.warn(
            { status: response.status, label: options.label, authMode, bytes: text.length },
            "instagram returned a body that opens like JSON but does not parse"
        );
        throw new InstagramError("network", `${options.label} returned malformed JSON`, response.status);
    }

    return { data: parsed as T, authMode };
}

/** Anonymous-only entrypoint. See `AnonymousRequestOptions` for why it exists. */
export function getAnonymousJson<T>(path: string, options: AnonymousRequestOptions): Promise<InstagramResponse<T>> {
    return getJson<T>(path, options);
}

/**
 * Test seams. Both are module state that must not leak between cases: the
 * www-claim persists by design, and the limiter would otherwise sleep for real
 * (its jitter runs to 15s), which both slows tests and lets concurrent files
 * interleave on the shared `fetch` mock.
 */
export const __testing = {
    resetWwwClaim: () => {
        wwwClaims.clear();
    },
    currentWwwClaim: (sessionId?: string) => wwwClaims.get(claimKeyFor(sessionId)) ?? "0",
    useInstantLimiter: () => {
        limiter = new RateLimiter({ random: () => 0, sleep: async () => undefined });
    },
    resetLimiter: () => {
        limiter = new RateLimiter();
    },
};

export { ASBD_ID, WEB_APP_ID, WEB_BASE };
