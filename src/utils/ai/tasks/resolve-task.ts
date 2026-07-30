import { logger } from "@genesiscz/utils/logger";
import { AiConfigStore } from "../config/AiConfigStore";
import type { TaskName } from "../config/schema";
import type { ModelRef } from "../core/model-ref";
import { ModelResolutionError, resolveModel } from "../core/resolve";
import type { ResolvedBinding } from "../core/types";
import type { Capability, ProviderBinding } from "../providers/plugin-types";
import { registerBuiltInPlugins } from "../providers/plugins";
import { tryProviderPlugin } from "../providers/registry";
import { taskModelDefault } from "./task-models";

/**
 * Task resolution WITH graceful degradation.
 *
 * `resolveModel` (core/resolve.ts) is deliberately strict: it walks the config
 * ladder and throws when no rung names a usable account, because a chat call
 * that silently lands on a different provider is a call the user did not agree
 * to pay for. The old `getProviderForTask` was the opposite — it swallowed the
 * preferred provider being unavailable and walked a nine-entry availability
 * chain (providers/index.ts:106-116) until something answered, which is why an
 * embed on a laptop with no API keys still worked.
 *
 * Both behaviours are wanted, so they live in two layers rather than one
 * compromise: the strict ladder decides, and this file catches its failure and
 * degrades — but ONLY when the caller named nothing. An explicit ref or a
 * configured default still fails loudly, exactly as before.
 */

/**
 * The nine-entry chain from `getProviderForTask`, verbatim in order, translated
 * from `AIProviderType` to plugin ids.
 *
 * "cloud" was `AICloudProvider("auto")`, which is not one provider but whichever
 * of the OpenAI-shaped keys happened to be set (providers/AICloudProvider.ts:89);
 * it expands to those three ids in the same position. Everything else is a 1:1
 * rename. GPU-capable runtimes stay first, which is the whole reason the order
 * was written down.
 */
const FALLBACK_ORDER: readonly string[] = [
    "ollama",
    "coreml",
    "darwinkit",
    "local-hf",
    "openai",
    "groq",
    "openrouter",
    "google",
    "assemblyai",
    "deepgram",
    "gladia",
];

const TASK_CAPABILITY: Record<TaskName, Capability> = {
    chat: "chat",
    embed: "embed",
    transcribe: "transcribe",
    tts: "tts",
    summarize: "summarize",
    translate: "translate",
    classify: "classify",
    sentiment: "sentiment",
    image: "image",
    realtime: "realtime",
};

export interface ResolveTaskOptions {
    task: TaskName;
    /** An explicit ModelRef. Naming one switches degradation OFF. */
    model?: ModelRef;
    /** Tool name, for `defaults.app.<app>.<task>`. */
    app?: string;
    /**
     * The binding method the caller is about to use. A candidate that declares
     * the capability but binds without the method (a local runtime with no
     * speech adapter, say) is skipped rather than handed back to blow up one
     * line later.
     */
    needs?: keyof Pick<ProviderBinding, "language" | "embedding" | "transcription" | "speech" | "image">;
}

export class NoProviderForTaskError extends Error {
    constructor(task: TaskName, tried: string[], cause: string) {
        super(
            `No available provider supports task "${task}". Tried: ${tried.join(", ") || "nothing"}. ` +
                `Last resolution error: ${cause}. ` +
                `Configure one with: tools ai config default set ${task} <@account/...>`
        );
        this.name = "NoProviderForTaskError";
    }
}

/**
 * Resolve and bind a provider for a task.
 *
 * Callers MUST call `binding.dispose?.()` in a `finally` — local runtimes hold a
 * loaded model per bind (local/adapters/index.ts:102), and nothing else frees it.
 */
export async function resolveForTask(opts: ResolveTaskOptions): Promise<ResolvedBinding> {
    const { log } = logger.scoped("ai-tasks");
    const capability = TASK_CAPABILITY[opts.task];
    const base = {
        task: opts.task,
        ...(opts.app ? { app: opts.app } : {}),
        fallbackModelId: taskModelDefault,
    };

    let failure: ModelResolutionError;

    try {
        const resolved = await resolveModel(opts.model, base);

        if (!opts.needs || typeof resolved.binding[opts.needs] === "function") {
            return resolved;
        }

        resolved.binding.dispose?.();
        failure = new ModelResolutionError(
            `Account "${resolved.account.name}" (provider "${resolved.plugin.id}") declares "${capability}" ` +
                `but its binding exposes no ${opts.needs}() model.`
        );
        log.debug(
            { task: opts.task, provider: resolved.plugin.id, needs: opts.needs },
            "resolved provider binds without the method this task needs"
        );
    } catch (err) {
        if (!(err instanceof ModelResolutionError)) {
            throw err;
        }

        failure = err;
    }

    // An explicit ref is a decision, not a preference: degrading past it would
    // bill a provider the caller never named.
    if (opts.model) {
        throw failure;
    }

    return degrade(opts, capability, failure);
}

/**
 * Walk the availability chain. A candidate qualifies when the plugin is
 * registered, declares the capability, this table can name a model for it, and
 * an enabled account exists — the plugin-era spelling of `supports(task) &&
 * isAvailable()`.
 */
async function degrade(
    opts: ResolveTaskOptions,
    capability: Capability,
    cause: ModelResolutionError
): Promise<ResolvedBinding> {
    const { log } = logger.scoped("ai-tasks");
    registerBuiltInPlugins();

    const store = await AiConfigStore.load();
    const tried: string[] = [];

    for (const providerId of FALLBACK_ORDER) {
        const plugin = tryProviderPlugin(providerId);

        if (!plugin?.capabilities.has(capability) || !taskModelDefault(providerId, capability)) {
            continue;
        }

        const accounts = store.accounts({ provider: providerId, enabled: true });

        if (accounts.length === 0) {
            continue;
        }

        tried.push(providerId);

        try {
            const resolved = await resolveModel(`@account/${accounts[0].id}`, {
                task: opts.task,
                store,
                fallbackModelId: taskModelDefault,
            });

            if (opts.needs && typeof resolved.binding[opts.needs] !== "function") {
                resolved.binding.dispose?.();
                continue;
            }

            log.info(
                { task: opts.task, provider: providerId, account: resolved.account.name },
                "preferred provider unavailable; degraded to the next one on the availability chain"
            );

            return resolved;
        } catch (err) {
            log.debug({ err, task: opts.task, provider: providerId }, "availability-chain candidate did not bind");
        }
    }

    throw new NoProviderForTaskError(opts.task, tried, cause.message);
}
