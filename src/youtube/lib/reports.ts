import { resolveArtifactPrice } from "@app/youtube/lib/artifact-access";
import type { YoutubeDatabase } from "@app/youtube/lib/db";
import { REPORT_SYNTHESIS_COST } from "@app/youtube/lib/users.types";

export const REPORT_MIN_MEMBERS = 2;
export const REPORT_MAX_MEMBERS = 20;

export interface ReportEstimate {
    /** Σ per-member summary price (reuse pricing applies) + flat synthesis fee. */
    creditCost: number;
    /** Members without an existing long summary (they will be generated). */
    membersNeedingSummary: number;
    perMemberCost: Record<string, number>;
}

export function estimateReportCost(
    db: YoutubeDatabase,
    opts: { userId: number; videoIds: string[] }
): ReportEstimate {
    const perMemberCost: Record<string, number> = {};
    let membersNeedingSummary = 0;
    let creditCost = REPORT_SYNTHESIS_COST;

    for (const videoId of opts.videoIds) {
        if (!db.hasArtifact("summary:long", videoId)) {
            membersNeedingSummary += 1;
        }

        const { price } = resolveArtifactPrice(db, { userId: opts.userId, kind: "summary:long", videoId });
        perMemberCost[videoId] = price;
        creditCost += price;
    }

    return { creditCost, membersNeedingSummary, perMemberCost };
}
