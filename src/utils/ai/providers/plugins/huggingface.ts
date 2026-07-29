import type { ImageModel } from "ai";
import { resolveCredential } from "../credentials";
import type { BindContext, ProviderBinding, ProviderPlugin } from "../plugin-types";

/**
 * HuggingFace, as an account rather than an ambient token.
 *
 * An `hf-cloud` account has existed since the v3→v4 config migration
 * (config/migrations/2026-04-07-migrateAI.ts:200-207 turns the old `hfToken`
 * into one), but nothing claimed the provider id, so `tools ai config doctor`
 * reported "no provider plugin registered for huggingface" against a perfectly
 * valid account.
 *
 * Capabilities are what the code actually routes here today, which is image
 * generation via `@huggingface/inference` (src/ai/index.ts:206-212). The token
 * is also what `@huggingface/transformers` reads when pulling gated weights for
 * the local runtimes, but that is a hub download rather than an inference call,
 * so it is not a capability.
 *
 * `HUGGINGFACE_TOKEN` / `HF_TOKEN` are declared as env fallbacks in the same
 * order the env facade already reads them (utils/env/envVariables.ts:21), which
 * is what keeps a machine that only exports one of them working.
 */

const MODEL_ID_FALLBACK = "stabilityai/stable-diffusion-xl-base-1.0";

interface HuggingFaceImageResult {
    arrayBuffer(): Promise<ArrayBuffer>;
}

/**
 * `InferenceClient.textToImage` answers with a Blob, or with a URL string when
 * the model is served through a hosted endpoint — both shapes come straight
 * from `tools ai image`, which has handled the pair since it was written.
 */
async function imageBytes(result: unknown): Promise<Uint8Array> {
    if (typeof result === "string") {
        const response = await fetch(result);
        return new Uint8Array(await response.arrayBuffer());
    }

    return new Uint8Array(await (result as HuggingFaceImageResult).arrayBuffer());
}

function toImageModel(token: string, modelId: string): ImageModel {
    return {
        specificationVersion: "v3",
        provider: "huggingface",
        modelId,
        maxImagesPerCall: 1,

        async doGenerate({ prompt, n }: { prompt: string; n?: number }) {
            // `@huggingface/inference` is an on-demand package (declared in
            // src/types/on-demand-packages.d.ts), so it is imported at call time
            // and its absence is a runtime error naming the install, not an
            // import-time crash for every tool that loads the plugin barrel.
            const { InferenceClient } = await import("@huggingface/inference");
            const client = new InferenceClient(token);
            const count = n ?? 1;
            const images: Uint8Array[] = [];

            for (let i = 0; i < count; i++) {
                images.push(await imageBytes(await client.textToImage({ model: modelId, inputs: prompt })));
            }

            return {
                images,
                warnings: [],
                response: { timestamp: new Date(), modelId, headers: undefined },
            };
        },
    } as ImageModel;
}

export const huggingFacePlugin: ProviderPlugin = {
    id: "huggingface",
    kind: "api-key",
    capabilities: new Set(["image"]),
    credential: { fields: ["apiKey"], envKeys: ["HUGGINGFACE_TOKEN", "HF_TOKEN"], required: ["apiKey"] },

    async bind(ctx: BindContext): Promise<ProviderBinding> {
        const { apiKey } = await resolveCredential(ctx.account, this.credential);

        if (!apiKey) {
            throw new Error("No API key resolved for huggingface");
        }

        return {
            accountId: ctx.account.id,
            providerId: "huggingface",
            billed: true,
            language: (modelId: string) => {
                throw new Error(
                    `huggingface generates images here; it has no chat model (${modelId}). ` +
                        "Point chat at another account with: tools ai config default set chat <@account/...>"
                );
            },
            image: (modelId: string) => toImageModel(apiKey, modelId || MODEL_ID_FALLBACK),
        } as ProviderBinding;
    },
};
