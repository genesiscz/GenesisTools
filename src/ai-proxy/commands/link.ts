import { loadConfigFresh } from "@app/ai-proxy/lib/config";
import { gatewayAccountStatus, linkGatewayAccount } from "@app/ai-proxy/lib/gateway-account";
import { suggestCommand } from "@genesiscz/utils/cli";
import { logger, out } from "@genesiscz/utils/logger";

export async function runLinkCommand(options: { status?: boolean }): Promise<void> {
    if (options.status) {
        const status = await gatewayAccountStatus();
        out.log[status.linked ? "success" : "warn"](status.detail);

        if (!status.linked) {
            out.log.info(suggestCommand("tools ai-proxy", { replaceCommand: ["link"] }));
        }

        return;
    }

    const config = await loadConfigFresh();

    try {
        const result = await linkGatewayAccount(config);
        out.log.success(
            `${result.created ? "Linked" : "Refreshed"} AI-config account "${result.accountId}" → ${result.endpoint}`
        );
        out.log.info(`Proxy key stored in the vault at ${result.keyPath} (the AI config holds only a pointer).`);
        out.log.info("Any tool can now target this proxy with a model ref like @proxy/grok/grok-4.5");
    } catch (err) {
        logger.error({ err }, "ai-proxy: gateway link failed");
        out.log.error(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
    }
}
