import { loadConfig } from "@app/ai-proxy/lib/config";
import { buildIntrospectText } from "@app/ai-proxy/lib/introspect";
import { out } from "@app/logger";
import clipboardy from "clipboardy";

export async function runIntrospectCommand(options: {
    json?: boolean;
    clipboard?: boolean;
    showSecrets?: boolean;
    section?: "accounts" | "endpoints" | "models" | "cursor" | "all";
    account?: string;
}): Promise<void> {
    const config = await loadConfig();
    const text = await buildIntrospectText(config, {
        section: options.section,
        accountName: options.account,
        showSecrets: options.showSecrets,
    });

    if (options.json) {
        out.result({
            baseUrl: `http://${config.listen.host}:${config.listen.port}/v1`,
            text,
            accounts: config.accounts,
        });
        return;
    }

    out.result(text);

    if (options.clipboard) {
        await clipboardy.write(text);
        out.log.success("Copied introspect output to clipboard");
    }
}
