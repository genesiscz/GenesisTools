import type { LanguageModel } from "ai";
import type { AIEmbeddingProvider } from "../../types";
import { AICoreMLProvider } from "../AICoreMLProvider";
import { AIDarwinKitProvider } from "../AIDarwinKitProvider";
import { AILocalProvider } from "../AILocalProvider";
import { AIOllamaProvider } from "../AIOllamaProvider";
import { toEmbeddingModel } from "../embedding-adapter";
import type { BindContext, Capability, ProviderBinding, ProviderPlugin } from "../plugin-types";

/**
 * On-device and self-hosted runtimes.
 *
 * These are adapters only. The runtime classes keep their current internals —
 * restructuring them (artifact caches, runtime lifecycles) is Phase 6. What this
 * file buys now is that a local provider is looked up, capability-checked and
 * disposed exactly like a cloud one.
 *
 * A runtime instance holds a loaded model, so one is created per model id and
 * cached on the binding; `dispose()` tears all of them down together, which is
 * why task facades must call it.
 */

interface LocalPluginSpec {
    id: string;
    capabilities: Capability[];
    /** Runtimes load a model at construction, so this is per model id. */
    createEmbedder?: (modelId: string) => AIEmbeddingProvider;
}

const SPECS: LocalPluginSpec[] = [
    {
        id: "local-hf",
        capabilities: ["embed", "transcribe", "translate", "summarize"],
        createEmbedder: () => new AILocalProvider(),
    },
    {
        id: "ollama",
        capabilities: ["embed", "summarize", "translate"],
        createEmbedder: (modelId: string) => new AIOllamaProvider({ defaultModel: modelId }),
    },
    {
        id: "coreml",
        capabilities: ["embed"],
        // Apple's built-in contextual embedder: no artifact to download, 512-dim.
        createEmbedder: (modelId: string) => new AICoreMLProvider({ modelId, contextual: true, dimensions: 512 }),
    },
    {
        id: "darwinkit",
        capabilities: ["embed", "classify", "sentiment"],
        createEmbedder: () => new AIDarwinKitProvider(),
    },
    {
        // macOS `say`. Its speech() adapter lands in Phase 5 with the task facade
        // that defines the voice/rate option surface; here it exists so the
        // provider is discoverable and capability-checkable.
        id: "macos",
        capabilities: ["tts"],
    },
];

function buildPlugin(spec: LocalPluginSpec): ProviderPlugin {
    return {
        id: spec.id,
        kind: "local",
        capabilities: new Set(spec.capabilities),
        credential: { fields: [], envKeys: [] },

        async bind(ctx: BindContext): Promise<ProviderBinding> {
            const runtimes = new Map<string, AIEmbeddingProvider>();

            return {
                accountId: ctx.account.id,
                providerId: spec.id,
                billed: false,
                language: (modelId: string): LanguageModel => {
                    throw new Error(
                        `${spec.id} has no chat model (${modelId}); it provides ${spec.capabilities.join(", ")}.`
                    );
                },
                ...(spec.createEmbedder
                    ? {
                          embedding: (modelId: string) => {
                              let runtime = runtimes.get(modelId);

                              if (!runtime) {
                                  runtime = spec.createEmbedder?.(modelId);

                                  if (!runtime) {
                                      throw new Error(`${spec.id} cannot embed`);
                                  }

                                  runtimes.set(modelId, runtime);
                              }

                              return toEmbeddingModel({ provider: runtime, providerId: spec.id, modelId });
                          },
                      }
                    : {}),
                dispose: () => {
                    for (const runtime of runtimes.values()) {
                        runtime.dispose?.();
                    }

                    runtimes.clear();
                },
            };
        },

        async health() {
            const probe = spec.createEmbedder?.("probe");

            if (!probe) {
                return { ok: true, detail: `${spec.id} needs no credential` };
            }

            try {
                const available = await probe.isAvailable();
                return { ok: available, detail: available ? "runtime available" : "runtime unavailable" };
            } finally {
                probe.dispose?.();
            }
        },
    };
}

export const localPlugins: ProviderPlugin[] = SPECS.map(buildPlugin);
