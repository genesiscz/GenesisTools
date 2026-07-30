import { logger } from "@genesiscz/utils/logger";
import { byId, byProvider } from "../catalog";
import { AiConfigStore } from "../config/AiConfigStore";
import type { AccountEntry, AiConfigData, TaskDefault, TaskName } from "../config/schema";
import type { Capability } from "../providers/plugin-types";
import { registerBuiltInPlugins } from "../providers/plugins";
import { providerPlugin } from "../providers/registry";
import { formatModelRef, type ModelRef, type ParsedModelRef, parseModelRef } from "./model-ref";
import type { ResolvedBinding, ResolvedModel, ResolvedTarget, ResolveOptions } from "./types";

/**
 * The one resolution ladder: a ModelRef (or nothing) in, a bound provider out.
 *
 * ⚠️ THREE functions in this repo are called `resolveModel`, and they answer
 * different questions. Import this one by its direct path
 * (`@genesiscz/utils/ai/core/resolve`) and never re-export it through a barrel
 * that also carries the other two:
 *
 *   - `src/ask/providers/ModelResolver.ts` — a pure fuzzy matcher over an
 *     already-detected provider's model list ("opus" → the best matching entry).
 *     No config, no I/O, no account.
 *   - `src/ai-proxy/lib/resolve-model.ts` — routes an incoming proxy model id
 *     (`<account>/<provider>/<model>`) to one of the ai-proxy SERVER's own
 *     accounts. It answers a request; it does not read the user's AI config.
 *   - this one — walks the user's config defaults, picks an account, binds its
 *     provider plugin and names the model. It is the only one that can spend
 *     money, and the only one that reads `~/.genesis-tools/ai/config.json`.
 *
 * Credentials are NOT resolved here: `providers/resolve.ts` owns that ladder and
 * the plugins call it through `resolveCredential`. This ladder decides WHICH
 * account; that one decides HOW its key is found.
 */

/**
 * Frozen order:
 *   explicit ref
 *     → defaults.app[app][task]
 *     → defaults.task[task]
 *     → defaults.account[task]
 *     → defaults.account.chat
 *     → error naming `tools ai config default set`
 *
 * An explicit ref never mixes with a CONFIGURED SPEC: when the caller names a
 * ref, `defaults.app` / `defaults.task` are skipped entirely rather than
 * consulted for whatever half the ref left out. This is `resolveProviderChoice`'s
 * `fallbackSpec` rule (src/youtube/lib/provider-choice.ts:9-13) carried over
 * verbatim — silently blending "I asked for opus" with a configured
 * "groq/llama" is how a user ends up billed by a provider they did not name.
 *
 * The default-ACCOUNT rungs are different and still apply: a bare `opus` says
 * nothing about which account should serve it, so the account default fills that
 * half. That matches the old behaviour too (provider-choice.ts:77 consults the
 * default account for the provider half of an explicit model).
 */

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

export class ModelResolutionError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ModelResolutionError";
    }
}

interface ModelRequest {
    accountId?: string;
    providerId?: string;
    modelId?: string;
    via: string;
}

/** Resolve without binding: no credential read, no network, no provider construction. */
export async function resolveModelTarget(
    ref: ModelRef | undefined,
    opts: ResolveOptions = {}
): Promise<ResolvedTarget> {
    const { log } = logger.scoped("ai-core");
    const store = opts.store ?? (await AiConfigStore.load());
    const cfg = store.data();

    registerBuiltInPlugins();

    const task: TaskName = opts.task ?? "chat";
    const request = buildRequest(ref, cfg, task, opts.app);
    const account = pickAccount(store, cfg, request, task);

    if ((cfg.disabledProviders ?? []).includes(account.provider)) {
        throw new ModelResolutionError(
            `Provider "${account.provider}" is switched off in the AI config, but account "${account.name}" resolves to it. ` +
                `Re-enable it with: tools ai config provider enable ${account.provider}`
        );
    }

    const plugin = providerPlugin(account.provider);
    const capability = TASK_CAPABILITY[task];

    // Local runtimes deliberately throw from `language()` (providers/plugins/local.ts:75).
    // Checking the declared capability first turns "ollama has no chat model" into a
    // resolution error naming the fix, instead of a stack trace out of the SDK.
    if (!plugin.capabilities.has(capability)) {
        throw new ModelResolutionError(
            `Account "${account.name}" uses provider "${plugin.id}", which cannot ${capability} ` +
                `(it provides ${[...plugin.capabilities].join(", ") || "nothing"}). ` +
                `Point the task at another account with: tools ai config default set ${task} <@account/...>`
        );
    }

    const modelId = request.modelId ?? defaultModelIdFor(account.provider, capability);

    if (!modelId) {
        throw new ModelResolutionError(
            `No model resolved for task "${task}"${opts.app ? ` in app "${opts.app}"` : ""} ` +
                `(account "${account.name}", provider "${account.provider}") and the catalog lists no default for it. ` +
                `Set one with: tools ai config default set ${task} <model>`
        );
    }

    const model = lookupModel(modelId, account.provider);
    const via = request.modelId ? request.via : `${request.via} + catalog default`;

    log.debug(
        { ref, task, app: opts.app, account: account.id, provider: account.provider, model: model.id, via },
        "resolved model target"
    );

    return { account, plugin, model, via };
}

export async function resolveModel(ref: ModelRef | undefined, opts: ResolveOptions = {}): Promise<ResolvedBinding> {
    const target = await resolveModelTarget(ref, opts);
    const binding = await target.plugin.bind({
        account: target.account,
        ...(opts.fetch ? { fetch: opts.fetch } : {}),
    });

    return { ...target, binding };
}

function buildRequest(ref: ModelRef | undefined, cfg: AiConfigData, task: TaskName, app?: string): ModelRequest {
    if (ref?.trim()) {
        const parsed = parseModelRef(ref, cfg);
        const suffix = parsed.alias ? ` (alias "${parsed.alias}")` : "";

        return { ...seedFrom(parsed), via: `ref ${formatModelRef(parsed)}${suffix}` };
    }

    const appRung = app ? cfg.defaults.app?.[app]?.[task] : undefined;

    if (hasSpec(appRung)) {
        return fromTaskDefault(appRung, cfg, `defaults.app.${app}.${task}`);
    }

    const taskRung = cfg.defaults.task?.[task];

    if (hasSpec(taskRung)) {
        return fromTaskDefault(taskRung, cfg, `defaults.task.${task}`);
    }

    return { via: "defaults.account" };
}

function hasSpec(rung: TaskDefault | undefined): rung is TaskDefault {
    return Boolean(rung?.model || rung?.provider);
}

function fromTaskDefault(rung: TaskDefault, cfg: AiConfigData, via: string): ModelRequest {
    const seed = rung.model ? seedFrom(parseModelRef(rung.model, cfg)) : {};

    // `provider` only fills a half the model ref left open, so a rung written as
    // `{ provider: "anthropic", model: "@account/acc_x:opus" }` still bills acc_x.
    if (rung.provider && !seed.providerId && !seed.accountId) {
        return { ...seed, providerId: rung.provider, via };
    }

    return { ...seed, via };
}

function seedFrom(parsed: ParsedModelRef): Omit<ModelRequest, "via"> {
    switch (parsed.kind) {
        case "bare":
            return { modelId: parsed.modelId };
        case "provider":
            return { providerId: parsed.providerId, modelId: parsed.modelId };
        case "account":
            return { accountId: parsed.accountId, ...(parsed.modelId ? { modelId: parsed.modelId } : {}) };
        case "proxy":
            // The gateway's own grammar is `<provider>/<model>`, which is exactly
            // what the slug and model halves spell (src/ai-proxy/lib/resolve-model.ts:93).
            return { providerId: "ai-proxy", modelId: `${parsed.slug}/${parsed.modelId}` };
    }
}

function pickAccount(store: AiConfigStore, cfg: AiConfigData, request: ModelRequest, task: TaskName): AccountEntry {
    if (request.accountId) {
        const account = store.account(request.accountId);

        if (!account) {
            throw new ModelResolutionError(
                `No account "${request.accountId}" in the AI config (from ${request.via}). ` +
                    `List them with: tools ai config account list`
            );
        }

        if (!account.enabled) {
            throw new ModelResolutionError(
                `Account "${account.name}" is disabled (from ${request.via}). ` +
                    `Enable it with: tools ai config account enable ${account.id}`
            );
        }

        return account;
    }

    if (request.providerId) {
        return accountForProvider(store, cfg, request, task);
    }

    const ref = defaultAccountRef(cfg, task);

    if (!ref) {
        throw new ModelResolutionError(
            `No default account for task "${task}" and none for "chat" either. ` +
                `Set one with: tools ai config default set ${task} <@account/...>`
        );
    }

    const account = store.account(ref.id);

    if (!account) {
        throw new ModelResolutionError(
            `${ref.via} points at "${ref.id}", which no longer exists. ` +
                `Repoint it with: tools ai config default set ${task} <@account/...>`
        );
    }

    if (!account.enabled) {
        throw new ModelResolutionError(
            `${ref.via} points at account "${account.name}", which is disabled. ` +
                `Enable it, or repoint with: tools ai config default set ${task} <@account/...>`
        );
    }

    return account;
}

/**
 * A provider was named but not an account. The task's default account wins when
 * it belongs to that provider (so `defaults.account.chat = @account/acc_work`
 * plus a bare `anthropic-sub/opus` keeps using acc_work rather than whichever
 * anthropic-sub account happens to be listed first), otherwise the first enabled
 * account for the provider.
 */
function accountForProvider(
    store: AiConfigStore,
    cfg: AiConfigData,
    request: ModelRequest,
    task: TaskName
): AccountEntry {
    const providerId = request.providerId;
    const preferredRef = defaultAccountRef(cfg, task);
    const preferred = preferredRef ? store.account(preferredRef.id) : undefined;

    if (preferred?.enabled && preferred.provider === providerId) {
        return preferred;
    }

    const candidates = store.accounts({ provider: providerId, enabled: true });

    if (candidates.length === 0) {
        throw new ModelResolutionError(
            `No enabled account for provider "${providerId}" (from ${request.via}). ` +
                `Add one with: tools ai config account add --provider ${providerId}`
        );
    }

    return candidates[0];
}

function defaultAccountRef(cfg: AiConfigData, task: TaskName): { id: string; via: string } | undefined {
    const accounts = cfg.defaults.account ?? {};

    for (const [key, via] of [
        [task, `defaults.account.${task}`],
        ["chat", "defaults.account.chat"],
    ] as const) {
        const ref = accounts[key];

        if (ref) {
            return { id: ref.slice("@account/".length), via };
        }
    }

    return undefined;
}

/**
 * Catalog keys and plugin ids are not the same vocabulary: the `anthropic-sub`
 * plugin serves models the catalog files under `anthropic`. Trying the plugin id
 * first and the `-sub`-stripped form second covers that without a hand-kept map
 * that would rot the moment a provider is added.
 */
function catalogKeysFor(providerId: string): string[] {
    const stripped = providerId.replace(/-sub$/, "");
    return stripped === providerId ? [providerId] : [providerId, stripped];
}

function defaultModelIdFor(providerId: string, capability: Capability): string | undefined {
    for (const key of catalogKeysFor(providerId)) {
        const entry = byProvider(key).find((model) => model.capabilities.has(capability) && !model.flags?.hidden);

        if (entry) {
            return entry.id;
        }
    }

    return undefined;
}

function lookupModel(modelId: string, providerId: string): ResolvedModel {
    const entry = byId(modelId);

    if (entry) {
        return entry;
    }

    const { log } = logger.scoped("ai-core");
    log.warn(
        { model: modelId, provider: providerId },
        "model is not in the static catalog; context window and pricing are unknown for this call"
    );

    return { id: modelId, provider: providerId, unlisted: true };
}
