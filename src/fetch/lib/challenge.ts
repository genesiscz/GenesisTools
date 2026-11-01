import type { BlockVerdict, TransportResponse } from "./types";

/** Statuses a bot wall answers with. `auto` retries through chrome on these even without a recognised page. */
export const BLOCK_STATUSES: ReadonlySet<number> = new Set([403, 429, 503]);

/** A marker that may also sit on a normal page counts only on a body shorter than this (challenge pages are small). */
const SMALL_BODY_CHARS = 200_000;

interface ChallengeRule {
    vendor: string;
    signal: string;
    test(response: TransportResponse, head: string): boolean;
    /** Only bodies shorter than SMALL_BODY_CHARS. */
    smallOnly?: boolean;
}

/** The `<title>` text, lower-cased, or "" when the page has none. */
function titleOf(head: string): string {
    const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(head);
    return match ? match[1].trim().toLowerCase() : "";
}

/**
 * Challenge titles seen on refused requests. "Kontrola zabezpečení" / "Kontrola zabezpečenia" and "Checking security"
 * are the Czech, Slovak and English titles of the Cloudflare challenge page Heureka serves (measured 2026-11-01).
 */
const CHALLENGE_TITLES = [
    "just a moment...",
    "attention required! | cloudflare",
    "checking your browser",
    "checking security",
    "kontrola zabezpečení",
    "kontrola zabezpečenia",
    "one more step",
    "pardon our interruption",
];

function serverVendor(response: TransportResponse): string {
    const server = (response.headers.server ?? "").toLowerCase();
    if (server.includes("cloudflare")) {
        return "cloudflare";
    }

    if (server.includes("akamai")) {
        return "akamai";
    }

    return "unknown";
}

/**
 * Body and header markers of bot-wall pages. Cloudflare also injects `/cdn-cgi/challenge-platform/scripts/jsd/` into
 * pages it lets through, so only the challenge orchestration path (`/challenge-platform/h/`) and `_cf_chl_opt`
 * count; both were on the refused Heureka page and absent from the passed one (2026-11-01).
 */
const RULES: ChallengeRule[] = [
    {
        vendor: "cloudflare",
        signal: "header cf-mitigated: challenge",
        test: (response) => (response.headers["cf-mitigated"] ?? "").toLowerCase() === "challenge",
    },
    { vendor: "cloudflare", signal: "body _cf_chl_opt", test: (_r, head) => head.includes("_cf_chl_opt") },
    {
        vendor: "cloudflare",
        signal: "body cdn-cgi/challenge-platform/h/",
        test: (_r, head) => head.includes("/cdn-cgi/challenge-platform/h/"),
    },
    {
        vendor: "akamai",
        signal: "body sec-if-cpt-container",
        test: (_r, head) => head.includes("sec-if-cpt-container"),
    },
    { vendor: "akamai", signal: "body bm-verify", test: (_r, head) => head.includes("bm-verify"), smallOnly: true },
    {
        vendor: "akamai",
        signal: "Access Denied page with a Reference #",
        test: (_r, head) => titleOf(head) === "access denied" && /Reference\s*#\s*[a-f0-9.]+/i.test(head),
    },
    {
        vendor: "datadome",
        signal: "body captcha-delivery.com",
        test: (_r, head) => head.includes("captcha-delivery.com"),
    },
    { vendor: "perimeterx", signal: "body px-captcha", test: (_r, head) => head.includes("px-captcha") },
    {
        vendor: "imperva",
        signal: "body _Incapsula_Resource",
        test: (_r, head) => head.includes("_Incapsula_Resource"),
        smallOnly: true,
    },
];

/** How much of the body the markers are searched in: challenge pages put them early, and real pages can be MBs. */
const HEAD_CHARS = 64_000;

/** A recognised bot-challenge page, or null. Works on any status: some walls answer 200 with a challenge. */
export function detectChallenge(response: TransportResponse): BlockVerdict | null {
    const head = response.body.slice(0, HEAD_CHARS);
    const small = response.body.length < SMALL_BODY_CHARS;

    for (const rule of RULES) {
        if (rule.smallOnly && !small) {
            continue;
        }

        if (rule.test(response, head)) {
            return { vendor: rule.vendor, signal: rule.signal, challenge: true };
        }
    }

    const title = titleOf(head);
    if (small && CHALLENGE_TITLES.includes(title)) {
        return { vendor: serverVendor(response), signal: `title "${title}"`, challenge: true };
    }

    return null;
}

/** Why the response is not the page: a challenge, or a block status without one. Null for a normal answer. */
export function blockVerdict(response: TransportResponse): BlockVerdict | null {
    const challenge = detectChallenge(response);
    if (challenge) {
        return challenge;
    }

    if (BLOCK_STATUSES.has(response.status)) {
        return { vendor: serverVendor(response), signal: `HTTP ${response.status}`, challenge: false };
    }

    return null;
}

/** "a Cloudflare challenge (header cf-mitigated: challenge, HTTP 403)" or "HTTP 429 (server: unknown)". */
export function describeVerdict(verdict: BlockVerdict, status: number): string {
    const vendor = verdict.vendor === "unknown" ? "" : `${verdict.vendor[0].toUpperCase()}${verdict.vendor.slice(1)} `;
    if (verdict.challenge) {
        return `a ${vendor}challenge page (${verdict.signal}, HTTP ${status})`;
    }

    return `a ${vendor}refusal (${verdict.signal})`;
}
