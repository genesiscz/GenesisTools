import { ensureProxyAccountRefs } from "@app/ai-proxy/lib/account-refs";
import { loadConfig, saveConfig } from "@app/ai-proxy/lib/config";
import { buildPublicBaseUrl, buildPublicHealthUrl } from "@app/ai-proxy/lib/public-url";
import { registerServingProcess } from "@app/ai-proxy/lib/runtime";
import { createRuntime, startAiProxyServer } from "@app/ai-proxy/lib/server";
import { resolveTranslationMode } from "@app/ai-proxy/lib/translation-config";
import type { CursorTranslationMode, ThinkingPresentationMode } from "@app/ai-proxy/lib/types";
import { logger, out } from "@genesiscz/utils/logger";

/**
 * A single upstream socket reset used to kill the whole proxy.
 *
 * Observed twice on 2026-07-25: grok reset a streamed connection mid-response
 * (`ECONNRESET` from cli-chat-proxy.grok.com), the enrich and capture paths each
 * logged it as a warning, but the rejection was still unhandled at the top level
 * and Bun exited the process — taking every other in-flight request with it. A
 * 98-session mining run lost 83 sessions to that. One dropped upstream stream is
 * a per-request failure; it must never be a server outage.
 *
 * That incident was an unhandled REJECTION, which is what this survives. An
 * uncaught exception is a different animal: it can come from config, persistence
 * or server internals, and the runtime's state is not trustworthy afterwards, so
 * it is logged and the process exits rather than serving from a broken state.
 */
function keepServingThroughUpstreamFaults(): void {
    process.on("unhandledRejection", (reason) => {
        logger.error({ error: reason }, "ai-proxy: unhandled rejection — request failed, server staying up");
    });
    process.on("uncaughtException", (error) => {
        logger.error({ error }, "ai-proxy: uncaught exception — shutting down, state is no longer trustworthy");
        process.exit(1);
    });
}

export async function runServeCommand(options: {
    port?: number;
    host?: string;
    translateCursor?: CursorTranslationMode;
    thinking?: ThinkingPresentationMode;
    noTranslate?: boolean;
}): Promise<void> {
    keepServingThroughUpstreamFaults();

    const config = await ensureProxyAccountRefs({ load: loadConfig, save: saveConfig });
    // The port `status` health-probes and `down` acts on. A serve on any other
    // port is a second instance, not this one.
    const managedPort = config.listen.port;

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
    // Bun types `port` as optional (a unix-socket server has none); the port we
    // asked to listen on is the effective one either way.
    const servingPort = server.port ?? config.listen.port;

    const registered = await registerServingProcess({ serving: servingPort, configured: managedPort });

    if (!registered) {
        out.log.warn(
            `Serving on ${servingPort}, not the configured ${managedPort} — this instance is not registered, so 'tools ai-proxy status/down' still act on the configured proxy.`
        );
    }

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
