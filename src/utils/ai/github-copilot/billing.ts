import { githubApi } from "@app/utils/ai/github-copilot/github-api";
import { buildCopilotRequestHeaders } from "@app/utils/ai/github-copilot/headers";
import { COPILOT_USER_URL } from "@app/utils/ai/github-copilot/paths";
import type { CopilotUsageSummary } from "@app/utils/ai/github-copilot/types";

export async function fetchCopilotUserInfo(ghoToken: string): Promise<Record<string, unknown>> {
    return githubApi.get<Record<string, unknown>>(COPILOT_USER_URL, {
        headers: {
            Accept: "application/json",
            Authorization: `Bearer ${ghoToken}`,
            ...buildCopilotRequestHeaders([]),
        },
    });
}

export interface CopilotChatQuota {
    quotaRemaining?: number;
    percentRemaining?: number;
    quotaResetDate?: string;
}

export function parseCopilotChatQuota(raw: Record<string, unknown>): CopilotChatQuota | null {
    const snapshots = raw.quota_snapshots;

    if (!snapshots || typeof snapshots !== "object") {
        return null;
    }

    const chat = (snapshots as Record<string, unknown>).chat;
    if (!chat || typeof chat !== "object") {
        return null;
    }

    const chatRecord = chat as Record<string, unknown>;

    return {
        quotaRemaining: typeof chatRecord.quota_remaining === "number" ? chatRecord.quota_remaining : undefined,
        percentRemaining: typeof chatRecord.percent_remaining === "number" ? chatRecord.percent_remaining : undefined,
        quotaResetDate: typeof chatRecord.quota_reset_date === "string" ? chatRecord.quota_reset_date : undefined,
    };
}

export function summarizeCopilotUsage(raw: Record<string, unknown>): CopilotUsageSummary {
    const plan = typeof raw.copilot_plan === "string" ? raw.copilot_plan : undefined;
    const chat = parseCopilotChatQuota(raw);

    if (!chat) {
        return { plan, raw };
    }

    return {
        plan,
        quotaRemaining: chat.quotaRemaining,
        percentRemaining: chat.percentRemaining,
        quotaResetDate: chat.quotaResetDate,
        raw,
    };
}
