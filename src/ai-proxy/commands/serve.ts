import { loadConfig } from "@app/ai-proxy/lib/config";
import { buildPublicBaseUrl, buildPublicHealthUrl } from "@app/ai-proxy/lib/public-url";
import { createRuntime, startAiProxyServer } from "@app/ai-proxy/lib/server";
import { resolveTranslationMode } from "@app/ai-proxy/lib/translation-config";
import type { CursorTranslationMode, ThinkingPresentationMode } from "@app/ai-proxy/lib/types";
import { logger, out } from "@app/logger";

export async function runServeCommand(options: {
    port?: number;
    host?: string;
    translateCursor?: CursorTranslationMode;
    thinking?: ThinkingPresentationMode;
    noTranslate?: boolean;
}): Promise<void> {
    const config = await loadConfig();

    if (options.port !== undefined) {
        config.listen.port = options.port;
    }

    if (options.host) {
        config.listen.host = options.host;
    }

    const runtime = await createRuntime(config, {
        translateCursor: options.translateCursor,
        thinking: options.thinking,
        noTranslate: options.noTranslate,
    });

    const server = startAiProxyServer(runtime);
    const localUrl = `http://${config.listen.host}:${server.port}/v1`;
    const publicUrl = buildPublicBaseUrl(config);

    out.log.success(`ai-proxy listening on ${localUrl}`);
    if (publicUrl) {
        out.log.info(`Public Cursor URL: ${publicUrl}`);
        out.log.info(`Public health: ${buildPublicHealthUrl(config)}`);
    } else {
        out.log.info("No public URL configured — run: tools ai-proxy config setup-tunnel");
    }
    const translationMode = resolveTranslationMode({
        configMode: config.translation.cursorAgent,
        flagMode: options.translateCursor,
        noTranslate: options.noTranslate,
    });
    out.log.info(`Translation: ${translationMode}`);
    out.log.info(`Thinking: ${options.thinking ?? config.translation.thinking}`);
    logger.info({ port: server.port, host: config.listen.host }, "ai-proxy serve started");
}
