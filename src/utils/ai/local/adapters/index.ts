import type { LanguageModel } from "ai";
import { AICoreMLProvider } from "../../providers/AICoreMLProvider";
import { AIDarwinKitProvider } from "../../providers/AIDarwinKitProvider";
import { AILocalProvider } from "../../providers/AILocalProvider";
import { AIOllamaProvider } from "../../providers/AIOllamaProvider";
import { toEmbeddingModel } from "../../providers/embedding-adapter";
import type { BindContext, Capability, ProviderBinding, ProviderPlugin } from "../../providers/plugin-types";
import type { AIEmbeddingProvider } from "../../types";
import { ArtifactStore } from "../artifacts";
import { byTask, type LocalModelDescriptor } from "../descriptors";

/**
 * On-device and self-hosted runtimes, exposed to the provider-plugin layer.
 *
 * The descriptor catalogue decides which models belong to which plugin (a
 * descriptor's `provider` IS the plugin id) and the artifact store answers
 * whether their weights are already on disk. What each plugin still owns is how
 * to construct its runtime, because a runtime instance holds a loaded model:
 * one is created per model id and cached on the binding, and `dispose()` tears
 * all of them down together, which is why task facades must call it.
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
        // Apple's built-in contextual embedder: no artifact to download. The
        // declared 512 disagrees with the `coreml-contextual` descriptor's 768
        // and is kept as-is — the true width comes back from the native call,
        // and reconciling that metadata is a data question, not a restructuring
        // one.
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

/** One catalogue entry plus whether its weights are already on disk. */
export interface LocalModelState {
    descriptor: LocalModelDescriptor;
    /** True when nothing needs downloading — including models with no artifacts of ours. */
    cached: boolean;
}

/** The embedding models this plugin can serve, straight from the catalogue. */
export function descriptorsFor(pluginId: string): ReadonlyArray<LocalModelDescriptor> {
    return byTask("embed").filter((descriptor) => descriptor.provider === pluginId);
}

/**
 * The same list with cached-state resolved through the artifact store. The
 * store is injectable so callers (and tests) can point it at a scratch root
 * instead of the real cache.
 */
export async function modelStatesFor(pluginId: string, store?: ArtifactStore): Promise<LocalModelState[]> {
    const artifacts = store ?? ArtifactStore.default();
    const states: LocalModelState[] = [];

    for (const descriptor of descriptorsFor(pluginId)) {
        const resolved = await artifacts.ensure(descriptor.artifacts);
        states.push({ descriptor, cached: resolved.every((r) => r.cached) });
    }

    return states;
}

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
