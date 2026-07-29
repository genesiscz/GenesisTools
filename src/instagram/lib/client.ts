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

/**
 * Instagram's failure envelope, and the gate every marker scan sits behind.
 *
 * The markers are ordinary English otherwise: a profile whose biography reads
 * "no spam pls" or "please wait a few minutes, posting soon" comes back from
 * `web_profile_info` as a perfectly good HTTP 200, and scanning that body for
 * substrings turns a working account into a fabricated enforcement error. A
 * marker only means what it says inside a response Instagram itself failed.
 */
const FAIL_ENVELOPE = /"status"\s*:\s*"fail"/;

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

export interface InstagramResponse<T> {
    data: T;
    authMode: AuthMode;
}

/**
 * `x-ig-www-claim` is the one header that is genuinely load-bearing rather than
 * decorative: it starts as "0", and the server then hands back
 * `x-ig-set-www-claim`, which every subsequent request is expected to echo. Not
 * replaying it marks the client as not-a-browser across the whole session.
 */
let wwwClaim = "0";

let limiter = new RateLimiter();

function buildHeaders(options: RequestOptions): Record<string, string> {
    const headers: Record<string, string> = {
        "x-ig-app-id": WEB_APP_ID,
        "x-asbd-id": ASBD_ID,
        "x-ig-www-claim": wwwClaim,
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

function classify(status: number, body: string, authMode: AuthMode): Classification | undefined {
    const lower = body.toLowerCase();
    // Instagram answers enforcement with 200 + a fail envelope as readily as with
    // a 4xx, so neither signal alone is enough to decide the body is worth scanning.
    const failed = status >= 400 || FAIL_ENVELOPE.test(lower);

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

function extractChallengeUrl(body: string): string | undefined {
    const match = body.match(/"url"\s*:\s*"([^"]*challenge[^"]*)"/i);
    return match ? match[1].replace(/\\\//g, "/") : undefined;
}

export async function getJson<T>(path: string, options: RequestOptions): Promise<InstagramResponse<T>> {
    const url = path.startsWith("http") ? path : `${WEB_BASE}${path}`;
    const authMode: AuthMode = options.sessionId ? "session" : "anonymous";

    await limiter.acquire(options.label);
    log.debug({ url, label: options.label, authMode, budgetUsed: limiter.used }, "instagram request");

    let response: Response;
    try {
        response = await fetch(url, { headers: buildHeaders(options), redirect: "manual" });
    } catch (error) {
        log.warn({ error, url, label: options.label }, "instagram request failed at the network layer");
        throw new InstagramError("network", `Request to ${options.label} failed: ${String(error)}`);
    }

    const setClaim = response.headers.get("x-ig-set-www-claim");
    if (setClaim) {
        log.debug({ label: options.label }, "captured a fresh x-ig-www-claim to replay on later requests");
        wwwClaim = setClaim;
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
    const classification = classify(response.status, text, authMode);

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

    return { data: SafeJSON.parse(text) as T, authMode };
}

/**
 * Test seams. Both are module state that must not leak between cases: the
 * www-claim persists by design, and the limiter would otherwise sleep for real
 * (its jitter runs to 15s), which both slows tests and lets concurrent files
 * interleave on the shared `fetch` mock.
 */
export const __testing = {
    resetWwwClaim: () => {
        wwwClaim = "0";
    },
    currentWwwClaim: () => wwwClaim,
    useInstantLimiter: () => {
        limiter = new RateLimiter({ random: () => 0, sleep: async () => undefined });
    },
    resetLimiter: () => {
        limiter = new RateLimiter();
    },
};

export { ASBD_ID, WEB_APP_ID, WEB_BASE };
