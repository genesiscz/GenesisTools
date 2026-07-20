import type { ProxyProvider } from "@app/ai-proxy/lib/providers/types";
import { guardProxyRoute, jsonError } from "@app/ai-proxy/lib/route-guards";
import type { AiProxyConfig } from "@app/ai-proxy/lib/types";
import { scheduleBillingSync } from "@app/ai-proxy/lib/usage/billing-sync";
import { recordUsageRequest } from "@app/ai-proxy/lib/usage/store";
import { logger } from "@genesiscz/utils/logger";

/** OpenAI's Whisper file limit — audio uploads are bigger than chat bodies. */
const MAX_AUDIO_BODY_BYTES = 25 * 1024 * 1024;

/**
 * POST /v1/audio/transcriptions — OpenAI Whisper-compatible batch STT.
 * Multipart body with `file` + `model` (proxy model id, e.g.
 * martin/grok/grok-transcribe); the provider translates to its own STT API
 * (xAI has no OpenAI-shape transcriptions route — it posts to /v1/stt).
 */
export async function handleAudioTranscriptions(input: {
    req: Request;
    config: AiProxyConfig;
    providers: Map<string, ProxyProvider>;
}): Promise<Response> {
    const contentLength = input.req.headers.get("content-length");

    if (contentLength) {
        const declaredBytes = Number.parseInt(contentLength, 10);

        if (Number.isFinite(declaredBytes) && declaredBytes > MAX_AUDIO_BODY_BYTES) {
            return jsonError(413, "Audio body too large (max 25 MB)");
        }
    }

    let form: FormData;
    try {
        form = await input.req.formData();
    } catch {
        return jsonError(400, "Body must be multipart/form-data with a file field");
    }

    const file = form.get("file");

    if (!(file instanceof Blob)) {
        return jsonError(400, "Missing file field");
    }

    const model = form.get("model");
    const guarded = await guardProxyRoute({
        authReq: input.req,
        config: input.config,
        providers: input.providers,
        proxyModel: typeof model === "string" ? model : undefined,
        logLabel: "transcriptions",
    });

    if (guarded instanceof Response) {
        return guarded;
    }

    const { client, route, provider } = guarded;

    if (typeof provider.audioTranscriptions !== "function") {
        return jsonError(400, `Provider "${route.account.provider}" does not support audio transcriptions`);
    }

    const started = performance.now();
    const response = await provider.audioTranscriptions(input.req, route.upstreamId, form);
    const elapsedMs = Math.round(performance.now() - started);

    logger.info(
        {
            path: "/v1/audio/transcriptions",
            model,
            upstreamModel: route.upstreamId,
            status: response.status,
            elapsedMs,
            fileBytes: file.size,
            client: client.name,
        },
        "ai-proxy: request"
    );

    // STT bills per audio-second, not tokens — record the request without usage.
    recordUsageRequest({
        ts: new Date().toISOString(),
        account: route.accountName,
        client: client.name,
        provider: route.account.provider,
        proxyModel: typeof model === "string" ? model : String(model),
        upstreamModel: route.upstreamId,
        path: "/v1/audio/transcriptions",
        status: response.status,
        elapsedMs,
        stream: false,
        rateLimited: response.status === 429,
        error: response.status >= 400,
    });
    scheduleBillingSync(route.account, input.providers);

    return response;
}
