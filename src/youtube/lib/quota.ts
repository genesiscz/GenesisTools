import { logger } from "@app/logger";
import { SafeJSON } from "@app/utils/json";
import { monthKeyUtc } from "@app/youtube/lib/billing-cycle";
import { CORS_HEADERS } from "@app/youtube/lib/server/cors";
import type { YtUser } from "@app/youtube/lib/users.types";
import type { Youtube } from "@app/youtube/lib/youtube";

/**
 * Monthly free-action metering (spec §4.1). Applies to logged-in users with
 * NO active/past_due subscription and NO completed Stripe purchase — paying
 * customers are never metered. Disabled until `freeTier.actionsPerMonth` is
 * configured. The attempt is counted at gate time; a downstream failure does
 * not refund the quota unit (accepted simplification).
 *
 * Returns the ready 402 Response (code "quota_exhausted") or null to proceed —
 * the same gate idiom as `requireUser`.
 */
export async function enforceFreeQuota(yt: Youtube, user: YtUser): Promise<Response | null> {
    const freeTier = await yt.config.get("freeTier");
    const limit = freeTier.actionsPerMonth;

    if (limit === null) {
        return null;
    }

    const sub = yt.db.getSubscriptionByUserId(user.id);

    if (sub && sub.status !== "canceled") {
        return null;
    }

    if (yt.db.hasAnyStripeGrant(user.id)) {
        return null;
    }

    const month = monthKeyUtc();
    const result = yt.db.incrementQuotaIfBelow(user.id, month, limit);

    if (result.allowed) {
        return null;
    }

    logger.info({ userId: user.id, month, used: result.used, limit }, "youtube quota: free tier exhausted");

    return new Response(
        SafeJSON.stringify({ error: "monthly free quota exhausted", code: "quota_exhausted" }, { strict: true }),
        { status: 402, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
    );
}
