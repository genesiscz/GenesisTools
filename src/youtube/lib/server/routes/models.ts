import { SafeJSON } from "@app/utils/json";
import { CORS_HEADERS } from "@app/youtube/lib/server/cors";
import { toErrorResponse } from "@app/youtube/lib/server/error";
import type { Youtube } from "@app/youtube/lib/youtube";
import { providerManager } from "@ask/providers/ProviderManager";

export interface ModelPreset {
    label: string;
    provider: string;
    model: string;
    subscription?: boolean;
}

/**
 * Detect every provider account the user has configured (via ai-config) and
 * flatten to a `{provider, model}` matrix. The extension's dev-mode picker
 * renders this so users pick a real account instead of typing model IDs.
 */
export async function handleModelsRoute(req: Request, _url: URL, yt: Youtube): Promise<Response> {
    try {
        if (req.method !== "GET") {
            return new Response(SafeJSON.stringify({ error: "method not allowed" }, { strict: true }), {
                status: 405,
                headers: { "Content-Type": "application/json", ...CORS_HEADERS },
            });
        }

        const providers = await providerManager.detectProviders();
        const presets: ModelPreset[] = [];
        for (const provider of providers) {
            // Subscription billing is a provider trait (anthropic-sub, openai-sub, grok-sub), not per-model.
            const subscription = provider.subscription === true;
            for (const model of provider.models) {
                presets.push({
                    label: `${provider.name} · ${model.id}`,
                    provider: provider.name,
                    model: model.id,
                    subscription,
                });
            }
        }

        const cfg = await yt.config.get("provider");
        const defaults = {
            summarize: cfg?.summarize ?? null,
            qa: cfg?.qa ?? null,
            transcribe: cfg?.transcribe ?? null,
            embed: cfg?.embed ?? null,
        };

        return Response.json({ presets, defaults }, { headers: CORS_HEADERS });
    } catch (err) {
        return toErrorResponse(err);
    }
}
