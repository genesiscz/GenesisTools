import { buildProxyModelCatalog } from "@app/ai-proxy/lib/catalog";
import { providerDefinition } from "@app/ai-proxy/lib/providers/registry";
import {
    buildPublicBaseUrl,
    buildPublicHealthUrl,
    resolveCursorBaseUrl,
    resolveTunnelName,
} from "@app/ai-proxy/lib/public-url";
import type { AiProxyConfig } from "@app/ai-proxy/lib/types";
import { GROK_UPSTREAM_ENDPOINTS, getTokenPrefix } from "@genesiscz/utils/ai/grok";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";

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
            lines.push(`Setup tunnel: ${toolCommand("ai-proxy config setup-tunnel")}`);
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

            const definition = providerDefinition(account.provider);

            lines.push(...(definition ? await definition.introspect(account) : []));

            if (section === "all" || section === "endpoints") {
                lines.push("");
                lines.push("Upstream endpoints (subscription):");

                // A provider that lists none prints Grok's, as this command did before the provider table; the
                // output is pinned by introspect.test.ts, so changing it is a decision of its own.
                const endpoints = definition?.upstreamEndpoints ?? GROK_UPSTREAM_ENDPOINTS;

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
        lines.push(`Copilot login: ${toolCommand("ai-proxy accounts login")} github-copilot`);
    }

    return lines.join("\n");
}
