import type { GithubCopilotApi } from "@app/utils/ai/github-copilot/api";
import { parseCopilotChatQuota } from "@app/utils/ai/github-copilot/billing";
import type { CopilotModelRecord } from "@app/utils/ai/github-copilot/types";

export function toProxyId(accountName: string, upstreamId: string): string {
    return `${accountName}/github-copilot/${upstreamId}`;
}

export async function fetchCopilotModels(client: GithubCopilotApi): Promise<CopilotModelRecord[]> {
    const raw = await client.copilotGet<{ data?: unknown[] }>("/models");

    if (!Array.isArray(raw.data)) {
        return [];
    }

    const models: CopilotModelRecord[] = [];

    for (const entry of raw.data) {
        if (!entry || typeof entry !== "object") {
            continue;
        }

        const model = entry as Record<string, unknown>;
        const id = model.id;

        if (typeof id !== "string") {
            continue;
        }

        models.push({
            id,
            name: typeof model.name === "string" ? model.name : id,
            vendor: typeof model.vendor === "string" ? model.vendor : undefined,
            version: typeof model.version === "string" ? model.version : undefined,
            preview: typeof model.preview === "boolean" ? model.preview : undefined,
            capabilities:
                model.capabilities && typeof model.capabilities === "object"
                    ? (model.capabilities as CopilotModelRecord["capabilities"])
                    : undefined,
            model_picker_enabled:
                typeof model.model_picker_enabled === "boolean" ? model.model_picker_enabled : undefined,
            source: "live",
            description: typeof model.name === "string" ? model.name : id,
        });
    }

    return models;
}

export function formatCopilotUsageSummary(raw: Record<string, unknown>): string {
    const chat = parseCopilotChatQuota(raw);

    if (chat?.quotaRemaining !== undefined && chat.percentRemaining !== undefined) {
        return `Copilot chat quota: ${chat.quotaRemaining} remaining (${chat.percentRemaining}% left)`;
    }

    return "Copilot subscription";
}
