import { randomBytes } from "node:crypto";
import { validateClients } from "@app/ai-proxy/lib/clients";
import { loadConfigFresh, saveConfig } from "@app/ai-proxy/lib/config";
import type { AiProxyClientConfig, AiProxyProviderType } from "@app/ai-proxy/lib/types";
import { readClientLedger } from "@app/ai-proxy/lib/usage/client-ledger";
import { logger, out } from "@app/logger";
import { SafeJSON } from "@app/utils/json";

export async function clientsList(): Promise<void> {
    const config = await loadConfigFresh();
    const clients = config.clients ?? [];

    if (clients.length === 0) {
        out.log.info("No clients configured (proxyApiKey/owner only).");
        return;
    }

    out.result(
        SafeJSON.stringify(
            clients.map(({ key, ...rest }) => ({ ...rest, key: `${key.slice(0, 4)}…${key.slice(-4)}` })),
            null,
            2
        ) ?? "[]"
    );
}

export async function clientsAdd(input: {
    name: string;
    tokenCap?: number;
    costCap?: number;
    providers?: AiProxyProviderType[];
}): Promise<void> {
    const config = await loadConfigFresh();
    const key = randomBytes(24).toString("base64url");
    const client: AiProxyClientConfig = {
        name: input.name,
        key,
        ...(input.providers?.length ? { allowedProviders: input.providers } : {}),
        ...(input.tokenCap !== undefined ? { monthlyTokenCap: input.tokenCap } : {}),
        ...(input.costCap !== undefined ? { monthlyCostCapUsd: input.costCap } : {}),
    };
    const next = [...(config.clients ?? []), client];
    const problems = validateClients(next);

    if (problems.length > 0) {
        logger.error({ problems }, "ai-proxy: refusing to add client");
        out.log.error(problems.join("\n"));
        process.exitCode = 1;
        return;
    }

    await saveConfig({ ...config, clients: next });
    out.log.success(`Client "${input.name}" added.`);
    out.print(key);
    out.log.info("This key is shown ONCE — hand it to the user now.");
}

export async function clientsUsage(input: { month?: string; csv?: boolean }): Promise<void> {
    const month = input.month ?? new Date().toISOString().slice(0, 7);
    const byClient = readClientLedger().months[month] ?? {};
    const rows = Object.entries(byClient).map(([client, usage]) => ({ client, month, ...usage }));

    if (input.csv) {
        const header = "client,month,requests,prompt_tokens,completion_tokens,total_tokens,cost_usd,unpriced_requests";
        const lines = rows.map(
            (row) =>
                `${row.client},${row.month},${row.requests},${row.prompt_tokens},${row.completion_tokens},${row.total_tokens},${row.cost_usd.toFixed(4)},${row.unpriced_requests}`
        );
        out.print([header, ...lines].join("\n"));
        return;
    }

    out.result(SafeJSON.stringify(rows, null, 2) ?? "[]");
}
