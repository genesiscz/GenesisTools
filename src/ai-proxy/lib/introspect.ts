import { resolveGithubCopilotDataDir, resolveGrokAuthPath } from "@app/ai-proxy/lib/account-config";
import { buildProxyModelCatalog } from "@app/ai-proxy/lib/catalog";
import {
    buildPublicBaseUrl,
    buildPublicHealthUrl,
    resolveCursorBaseUrl,
    resolveTunnelName,
} from "@app/ai-proxy/lib/public-url";
import type { AiProxyConfig } from "@app/ai-proxy/lib/types";
import { logger } from "@app/logger";
import { fetchCopilotUserInfo, formatCopilotUsageSummary, readGithubToken } from "@app/utils/ai/github-copilot";
import { GITHUB_COPILOT_UPSTREAM_ENDPOINTS } from "@app/utils/ai/github-copilot/endpoints";
import { COPILOT_GHO_TOKEN_SERVICE, githubTokenPath } from "@app/utils/ai/github-copilot/paths";
import {
    formatBillingSummary,
    GROK_UPSTREAM_ENDPOINTS,
    GrokSubscriptionClient,
    getTokenPrefix,
} from "@app/utils/ai/grok";

export interface IntrospectOptions {
    section?: "accounts" | "endpoints" | "models" | "cursor" | "all";
    accountName?: string;
    showSecrets?: boolean;
}

function formatProxyApiKey(proxyApiKey: string, showSecrets?: boolean): string {
    return showSecrets ? proxyApiKey : getTokenPrefix(proxyApiKey);
}

export async function buildIntrospectText(config: AiProxyConfig, options?: IntrospectOptions): Promise<string> {
    const section = options?.section ?? "all";
    const lines: string[] = [];
    const baseUrl = resolveCursorBaseUrl(config);
    const publicBaseUrl = buildPublicBaseUrl(config);
    const publicHealthUrl = buildPublicHealthUrl(config);

    if (
        section === "all" ||
        section === "cursor" ||
        section === "accounts" ||
        section === "endpoints" ||
        section === "models"
    ) {
        lines.push("═══ AI Proxy ═══");
        lines.push(`Cursor URL:   ${baseUrl}`);
        if (publicBaseUrl) {
            lines.push(`Public host:  ${config.public?.hostname ?? "—"}`);
            lines.push(`Public path:  ${config.public?.basePath ?? "/"}`);
            lines.push(`Health:       ${publicHealthUrl ?? "—"}`);
            lines.push(`Tunnel:       ${resolveTunnelName(config.public) ?? "—"}`);
        } else {
            lines.push(`Local only:   http://${config.listen.host}:${config.listen.port}/v1`);
            lines.push(`Setup tunnel: tools ai-proxy config setup-tunnel`);
        }
        lines.push(`API Key:      ${formatProxyApiKey(config.proxyApiKey, options?.showSecrets)}`);
        lines.push(`Translation:  cursorAgent=${config.translation.cursorAgent}`);
        lines.push(`Thinking:     ${config.translation.thinking} (raw=inline, cursor=native, folded=details)`);
        lines.push("");
        lines.push("Endpoints served:");
        lines.push("  GET  /v1/models");
        lines.push("  POST /v1/chat/completions");
        lines.push("  POST /v1/responses");
        lines.push("  GET  /health");
        lines.push("  GET  /openai/v1/models");
        lines.push("  POST /openai/v1/chat/completions");
        lines.push("  POST /openai/v1/responses");
        lines.push("");
    }

    const accounts = config.accounts.filter((account) =>
        options?.accountName ? account.name === options.accountName : true
    );

    const needsCatalog = section === "all" || section === "models" || section === "cursor";
    const modelCatalog = needsCatalog ? await buildProxyModelCatalog(config.accounts) : [];

    for (const account of accounts) {
        if (section === "all" || section === "accounts" || section === "endpoints" || section === "models") {
            lines.push(`═══ Account: ${account.name}${account.label ? ` (${account.label})` : ""} ═══`);
            lines.push(`Provider:     ${account.provider} (slug: ${account.providerSlug})`);

            if (account.provider === "grok-subscription") {
                const authPath = resolveGrokAuthPath(account);
                lines.push(`Upstream:     ${account.baseUrl ?? "https://cli-chat-proxy.grok.com/v1"}`);
                lines.push(`Auth:         ${authPath}`);

                try {
                    const client = await GrokSubscriptionClient.fromAuthFile(authPath);
                    if (client) {
                        const [settings, billing] = await Promise.all([client.getSettings(), client.getBilling()]);
                        lines.push(`Tier:         ${settings.subscription_tier_display ?? "unknown"}`);
                        lines.push(`Usage:        ${formatBillingSummary(billing)}`);
                    }
                } catch (err) {
                    logger.warn(
                        { err, account: account.name, authPath },
                        "ai-proxy introspect: grok auth probe failed"
                    );
                    lines.push("Auth status:  unavailable");
                }
            }

            if (account.provider === "github-copilot-subscription") {
                const dataDir = resolveGithubCopilotDataDir(account);
                lines.push(`Upstream:     ${account.baseUrl ?? "https://api.githubcopilot.com"}`);
                lines.push(
                    `Auth:         AuthStorage(${COPILOT_GHO_TOKEN_SERVICE}) — legacy ${githubTokenPath(dataDir)}`
                );

                try {
                    const gho = await readGithubToken(dataDir);
                    if (gho) {
                        const raw = await fetchCopilotUserInfo(gho);
                        const plan = typeof raw.copilot_plan === "string" ? raw.copilot_plan : "unknown";
                        lines.push(`Tier:         ${plan}`);
                        lines.push(`Usage:        ${formatCopilotUsageSummary(raw)}`);
                    }
                } catch (err) {
                    logger.warn(
                        { err, account: account.name, dataDir },
                        "ai-proxy introspect: copilot auth probe failed"
                    );
                    lines.push("Auth status:  unavailable");
                }
            }

            if (section === "all" || section === "endpoints") {
                lines.push("");
                lines.push("Upstream endpoints (subscription):");

                const endpoints =
                    account.provider === "github-copilot-subscription"
                        ? GITHUB_COPILOT_UPSTREAM_ENDPOINTS
                        : GROK_UPSTREAM_ENDPOINTS;

                for (const endpoint of endpoints) {
                    lines.push(`  ${endpoint.method.padEnd(4)} ${endpoint.path}`);
                }
            }

            if (section === "all" || section === "models") {
                const models = modelCatalog.filter((model) => model.accountName === account.name);
                lines.push("");
                lines.push("Models (copy to Cursor):");
                for (const model of models) {
                    lines.push(`  ${model.proxyId}`);
                }
            }

            lines.push("");
        }
    }

    if (section === "all" || section === "cursor") {
        const firstModel = modelCatalog[0]?.proxyId ?? "<account>/grok/grok-composer-2.5-fast";
        lines.push("═══ Cursor BYOK ═══");
        lines.push(`Override OpenAI Base URL: ${baseUrl}`);
        lines.push(`API Key: ${formatProxyApiKey(config.proxyApiKey, options?.showSecrets)}`);
        lines.push(`Add model: ${firstModel}`);
        lines.push("Translation: start with auto; if Agent breaks, run: ai-proxy serve --no-translate");
        lines.push("Copilot login: tools ai-proxy accounts login github-copilot");
    }

    return lines.join("\n");
}
