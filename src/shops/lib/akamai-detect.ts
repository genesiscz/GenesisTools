/**
 * Akamai bot-block detection for Itesco (and any other Akamai-fronted shop we add later).
 *
 * Three independent signals; ANY one triggers the block path:
 *
 *   (a) HTTP status in {403, 429, 503}
 *   (b) Body contains the literal substring "sec-if-cpt-container"
 *       (verified marker — actors/itesco-daily/main.js line 345)
 *   (c) Body matches /Reference\s*#\s*[a-f0-9.]+/i
 *       (Akamai's customer-facing 403 page footer)
 *
 * `_abck` Set-Cookie is INTENTIONALLY ignored as a block signal — it appears
 * on every visit (challenged or not). It's captured separately by
 * extractAbckCookie() for observability.
 */

export interface AkamaiInput {
    status: number;
    body: string;
    setCookie: readonly string[];
}

const REFERENCE_ID_REGEX = /Reference\s*#\s*[a-f0-9.]+/i;
const SEC_IF_CPT_MARKER = "sec-if-cpt-container";
const BLOCK_STATUSES = new Set([403, 429, 503]);

export function isAkamaiBlock(input: AkamaiInput): boolean {
    if (BLOCK_STATUSES.has(input.status)) {
        return true;
    }

    if (input.body.includes(SEC_IF_CPT_MARKER)) {
        return true;
    }

    if (REFERENCE_ID_REGEX.test(input.body)) {
        return true;
    }

    return false;
}

export function classifyAkamaiSignals(input: AkamaiInput): string[] {
    const out: string[] = [];
    if (BLOCK_STATUSES.has(input.status)) {
        out.push(`status:${input.status}`);
    }

    if (input.body.includes(SEC_IF_CPT_MARKER)) {
        out.push("body:sec-if-cpt-container");
    }

    if (REFERENCE_ID_REGEX.test(input.body)) {
        out.push("body:reference-id");
    }

    return out;
}

const ABCK_REGEX = /_abck=([^;]+)/;

/**
 * Extract `_abck` cookie value from a Set-Cookie array, capped at 80 chars.
 * Observability-only; does NOT indicate a block.
 */
export function extractAbckCookie(setCookie: readonly string[]): string | null {
    for (const c of setCookie) {
        const m = ABCK_REGEX.exec(c);
        if (m) {
            return (m[1] ?? "").slice(0, 80);
        }
    }

    return null;
}
