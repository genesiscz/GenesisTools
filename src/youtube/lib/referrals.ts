import { randomBytes } from "node:crypto";
import type { ReferralOffer, ReferralsConfig } from "@app/youtube/lib/config.types";

/** No 0/O/1/I — codes get read aloud and retyped. */
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 8;

export function generateReferralCode(): string {
    const bytes = randomBytes(CODE_LENGTH);
    let code = "";

    for (const byte of bytes) {
        code += CODE_ALPHABET[byte % CODE_ALPHABET.length];
    }

    return code;
}

/** First offer whose [from, to] window contains `nowIso`; null when disabled or none match. */
export function findActiveOffer(config: ReferralsConfig, nowIso: string): ReferralOffer | null {
    if (!config.enabled) {
        return null;
    }

    const now = Date.parse(nowIso);

    return (
        config.offers.find((offer) => {
            const from = Date.parse(offer.from);
            const to = Date.parse(offer.to);

            return Number.isFinite(from) && Number.isFinite(to) && now >= from && now <= to;
        }) ?? null
    );
}

/** Referrers may see WHO converted, not harvest addresses. */
export function maskEmail(email: string): string {
    const at = email.indexOf("@");

    if (at <= 0) {
        return "***";
    }

    return `${email.slice(0, Math.min(2, at))}***${email.slice(at)}`;
}
