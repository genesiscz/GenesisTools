import { logger } from "@app/logger";
import { SafeJSON } from "@app/utils/json";
import { resolveProviderChoice } from "@app/youtube/lib/provider-choice";
import { isPowerRole, roleForEmail } from "@app/youtube/lib/roles";
import { resolveUser } from "@app/youtube/lib/server/auth";
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

export interface ResolvedModelDefault {
    provider: string;
    model: string;
}

// Resolves a task's configured spec to the CONCRETE {provider, model} the
// server would actually use — the same resolution the generate/qa routes run —
// so clients can display "server default" as a real name instead of a mystery.
async function resolveTaskDefault(spec: string | null | undefined): Promise<ResolvedModelDefault | null> {
    try {
        const choice = await resolveProviderChoice({ fallbackSpec: spec });
        return { provider: choice.provider.name, model: choice.model.id };
    } catch (error) {
        logger.debug({ error, spec }, "models route: task default did not resolve");
        return null;
    }
}

/**
 * Detect every provider account the user has configured (via ai-config) and
 * flatten to a `{provider, model}` matrix. The extension's dev-mode picker
 * renders this so users pick a real account instead of typing model IDs.
 */
export async function handleModelsRoute(req: Request, url: URL, yt: Youtube): Promise<Response> {
    try {
        if (req.method !== "GET") {
            return new Response(SafeJSON.stringify({ error: "method not allowed" }, { strict: true }), {
                status: 405,
                headers: { "Content-Type": "application/json", ...CORS_HEADERS },
            });
        }

        // Model internals are admin/dev-only (spec §1). Anonymous = local
        // operator (open mode) or service key — those stay allowed; in key
        // mode anonymous requests were already rejected at the gate.
        const viewer = resolveUser(req, url, yt.db);

        if (viewer) {
            const role = roleForEmail(await yt.config.get("powerUsers"), viewer.email);

            if (!isPowerRole(role)) {
                logger.debug({ userId: viewer.id, role }, "models route: rejected non-power user");

                return new Response(
                    SafeJSON.stringify({ error: "model catalog is admin-only", code: "forbidden" }, { strict: true }),
                    { status: 403, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
                );
            }
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
            summarize: await resolveTaskDefault(cfg?.summarize),
            qa: await resolveTaskDefault(cfg?.qa),
            transcribe: cfg?.transcribe ?? null,
            embed: cfg?.embed ?? null,
        };

        return Response.json({ presets, defaults }, { headers: CORS_HEADERS });
    } catch (err) {
        return toErrorResponse(err);
    }
}
