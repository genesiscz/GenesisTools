import type { OAuthProfileResponse } from "./auth";

/**
 * The plan label shown beside an account ("max 5x", "pro"), read off the OAuth
 * profile's rate-limit tier.
 *
 * Lives here rather than in `src/claude/lib/config` because the anthropic-sub
 * provider plugin needs it, and `@genesiscz/utils` is a package whose contract is
 * that nothing under it imports a tool folder.
 */
export function determineAccountLabel(profile: OAuthProfileResponse | undefined): string | undefined {
    if (!profile) {
        return undefined;
    }

    const tier = profile.organization.rate_limit_tier;

    if (tier.includes("max")) {
        // Extract multiplier: "max_5x" → "max 5x", "max_20x" → "max 20x"
        const match = tier.match(/max[_\s]*(\d+x?)/i);
        // Fall back to raw tier value (e.g. "max_5") rather than just "max"
        return match ? `max ${match[1]}` : tier.replace(/_/g, " ");
    }

    if (tier.includes("pro")) {
        return "pro";
    }

    return profile.organization.billing_type;
}
