import type { SharedV4ProviderMetadata } from "@ai-sdk/provider";
import type { ProviderChoice } from "@genesiscz/utils/ask/types";
import { getLanguageModel } from "@genesiscz/utils/ask/types/provider";
import {
    usageCacheReadTokens,
    usageCacheWriteTokens,
    usageInputNoCacheTokens,
} from "@genesiscz/utils/ask/usage-tokens";
import { applySystemPromptPrefix } from "@genesiscz/utils/claude/subscription-billing";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import type { LanguageModel, LanguageModelUsage, ModelMessage, ToolSet } from "ai";
import { generateObject, generateText, stepCountIs, streamObject, streamText } from "ai";
import type { z } from "zod";
import { buildProviderOptions } from "../prompt-caching";
import { recordUsage } from "../usage";
import type { ModelRef } from "./model-ref";
import { resolveModel } from "./resolve";
import type { ResolvedBinding, ResolveOptions } from "./types";

/**
 * The one place a chat call is actually made.
 *
 * Before this, `call-llm.ts` and `ask`'s ChatEngine each held their own copy of
 * the same six lines — resolve a LanguageModel, prefix the system prompt, build
 * provider options, call `streamText`/`generateText`, drain the stream, dig the
 * usage out — and the copies had already drifted (one honoured a broken output
 * pipe, the other did not; one applied the subscription billing prefix through a
 * helper, the other reimplemented the null cases). Everything above this file
 * now describes WHAT to call; this file is HOW.
 *
 * `applySystemPromptPrefix` and `buildProviderOptions` deliberately stay in
 * their existing homes (`utils/claude/subscription-billing`, `utils/ai/prompt-caching`)
 * and are imported here: they have callers outside this path, and moving them
 * would be a rename disguised as a refactor.
 */

/** How many tool round-trips a call may take before it stops on its own. */
const DEFAULT_MAX_STEPS = 5;

// Module scope on purpose: `logger.scoped` builds a pino child AND two `out`
// objects on every call, and this file runs on every LLM call in the repo. The
// binding is constant for the module's lifetime.
const { log } = logger.scoped("ai-core");

export interface CallLLMOptions {
    systemPrompt: string;
    userPrompt: string;
    /**
     * The pre-Phase-4 way to name a target: an already-detected provider plus a
     * model record. Still fully supported — `ask` and `youtube` build these from
     * their own selection UI — but new callers should pass `model` instead and
     * let the one resolution ladder decide.
     */
    providerChoice?: ProviderChoice;
    /** A ModelRef (`opus`, `anthropic-sub/opus`, `@account/acc_x:opus`) or an already-resolved binding. */
    model?: ModelRef | ResolvedBinding;
    /** Ladder inputs used only when `model` is a ref that needs resolving. */
    task?: ResolveOptions["task"];
    app?: ResolveOptions["app"];
    streaming?: boolean;
    maxTokens?: number;
    temperature?: number;
    /** Extra per-request HTTP headers, e.g. the ai-proxy's `x-gt-*` job tags. */
    headers?: Record<string, string | undefined>;
    /** Write streaming chunks to this writable (defaults to process.stdout) */
    streamTarget?: NodeJS.WritableStream;
}

export interface CallLLMResult {
    content: string;
    usage?: LanguageModelUsage;
}

export interface CallLLMStructuredOptions<T> {
    systemPrompt: string;
    userPrompt: string;
    providerChoice?: ProviderChoice;
    model?: ModelRef | ResolvedBinding;
    task?: ResolveOptions["task"];
    app?: ResolveOptions["app"];
    schema: z.ZodType<T>;
    maxTokens?: number;
    temperature?: number;
    /**
     * When set, the call streams via `streamObject` and invokes this with each
     * best-effort partial object. Falls back silently to `generateObject` when
     * the provider rejects streaming before the first chunk.
     */
    onPartial?: (partial: unknown) => void;
}

export interface CallLLMStructuredResult<T> {
    object: T;
    /** `JSON.stringify(object, null, 2)` — convenient for activity-feed prompt logs. */
    content: string;
    usage?: LanguageModelUsage;
}

/**
 * A model ready to be called, with the two things every call site kept having to
 * remember about it: which provider dialect it speaks (`providerType`, which
 * decides the WHAM/cache provider options) and whether its plan requires a
 * billing prefix on the system prompt.
 */
export interface CallTarget {
    model: LanguageModel;
    providerType?: string;
    systemPromptPrefix?: string;
    /** `<provider>/<model>`, for logs. */
    label: string;
    /**
     * Who pays, what dialect, which model — the three things a usage row needs
     * and a `label` cannot be split back into (an account name may contain a
     * slash). Optional because `resolveCallTarget` is not the only way to build
     * a target; a call whose account is unknown is recorded as `unknown` rather
     * than not recorded.
     */
    accountId?: string;
    provider?: string;
    modelId?: string;
    /** Which surface is spending, for `defaults.app.*` and for the usage row. */
    app?: string;
    /**
     * Release a binding THIS function resolved, set only when it did.
     *
     * Local runtimes hold native handles, so a binding nobody frees is a real
     * leak. The ownership rule is what makes this safe: a caller who passed an
     * already-resolved `ResolvedBinding` still owns it and may reuse it for
     * further calls, so we must not dispose that one. Only the binding we
     * created from a bare `ModelRef` is ours to release.
     */
    dispose?: () => void;
}

export interface CoreChatOptions {
    target: CallTarget;
    /** The caller's system prompt, BEFORE any subscription prefix. */
    system?: string;
    /** Single-turn. Mutually exclusive with `messages`. */
    prompt?: string;
    /** Multi-turn, including tool calls and results. Mutually exclusive with `prompt`. */
    messages?: ModelMessage[];
    tools?: ToolSet;
    maxSteps?: number;
    maxTokens?: number;
    temperature?: number;
    /**
     * Extra HTTP headers for THIS request. The ai-proxy reads `x-gt-session` /
     * `x-gt-stage` / `x-gt-run` / `x-gt-label` off them and groups its transcripts
     * and usage records by those tags (src/ai-proxy/lib/usage/transcripts.ts:419).
     *
     * They belong on the call rather than on the binding: a binding is built once
     * per account and reused, while tags change from one request to the next.
     */
    headers?: Record<string, string | undefined>;
    /**
     * Cancels the call. A streamed call that is aborted mid-flight ends its
     * stream rather than throwing, so whatever `onChunk` already emitted is the
     * partial answer — that is what `MiniAgent.interject` keeps in history.
     */
    abortSignal?: AbortSignal;
    stream?: boolean;
    /** Required when `stream` is set: where text deltas go. */
    onChunk?: (text: string) => void;
    onThinking?: (text: string) => void;
    onToolCall?: (name: string, input: unknown) => void;
    onToolResult?: (name: string, output: unknown) => void;
}

export interface CoreChatResult {
    content: string;
    usage?: LanguageModelUsage;
    /** SDK response messages including tool calls/results — the caller's next-turn context. */
    responseMessages?: ModelMessage[];
}

/**
 * Prefix rules, in one place.
 *
 * A subscription plan may require a billing line ahead of the user's system
 * prompt; a caller may have no system prompt at all. Both ChatEngine and
 * call-llm had their own spelling of this, and only one of them handled "prefix
 * but no user prompt".
 */
export function effectiveSystemPrompt(prefix: string | undefined, base: string | undefined): string | undefined {
    if (!prefix && !base) {
        return undefined;
    }

    if (!base) {
        return prefix;
    }

    return applySystemPromptPrefix(prefix, base);
}

/** The single `streamText`/`generateText` call. Everything else in this file funnels here. */
export async function coreChat(options: CoreChatOptions): Promise<CoreChatResult> {
    const { target, tools } = options;
    const hasTools = Boolean(tools && Object.keys(tools).length > 0);

    const settings = {
        model: target.model,
        system: effectiveSystemPrompt(target.systemPromptPrefix, options.system),
        providerOptions: buildProviderOptions(target.providerType),
        ...(options.headers ? { headers: options.headers } : {}),
        ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
        ...(options.maxTokens ? { maxOutputTokens: options.maxTokens } : {}),
        ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
        ...(hasTools && tools ? { tools, stopWhen: stepCountIs(options.maxSteps ?? DEFAULT_MAX_STEPS) } : {}),
    };

    // `messages` and `prompt` are mutually exclusive in the SDK's own type, so the
    // branch has to produce one concrete shape rather than an object with both optional.
    const args = options.messages
        ? { ...settings, messages: options.messages }
        : { ...settings, prompt: options.prompt ?? "" };

    if (!options.stream) {
        const result = await generateText(args);
        const costUsd = upstreamCostUsd(result.providerMetadata);

        logUsage({ target, usage: result.usage, ...(costUsd === undefined ? {} : { costUsd }) });

        return {
            content: result.text,
            usage: result.usage,
            responseMessages: result.response.messages as ModelMessage[],
        };
    }

    const result = await streamText(args);
    let content = "";

    // fullStream rather than textStream: reasoning models emit thinking deltas
    // long before the first content token, and a tool loop reports its calls the
    // same way. A caller that only wants text simply passes no onThinking.
    for await (const part of result.fullStream) {
        if (part.type === "text-delta") {
            content += part.text;
            options.onChunk?.(part.text);
        } else if (part.type === "reasoning-delta") {
            options.onThinking?.(part.text);
        } else if (part.type === "tool-call") {
            options.onToolCall?.(part.toolName, "input" in part ? part.input : undefined);
        } else if (part.type === "tool-result") {
            options.onToolResult?.(part.toolName, "output" in part ? part.output : undefined);
        }
    }

    if (options.abortSignal?.aborted) {
        // `result.usage` / `result.response` never settle for a cancelled call.
        // The text collected so far is the answer the caller gets.
        log.debug({ model: target.label, chars: content.length }, "stream aborted — returning partial text");

        return { content };
    }

    const usage = await result.usage;
    const response = await result.response;
    const costUsd = upstreamCostUsd(await result.providerMetadata);

    logUsage({ target, usage, ...(costUsd === undefined ? {} : { costUsd }) });
    log.debug({ model: target.label, chars: content.length }, "stream drained");

    return { content, usage, responseMessages: response.messages as ModelMessage[] };
}

/**
 * The charge OpenRouter itself reports for the route it actually took.
 *
 * Keyed explicitly on `openrouter` rather than generically on "whatever provider
 * put a `cost` in its metadata": another provider's differently-scaled `cost`
 * (credits, cents, per-1K) picked up by accident would be booked as dollars and
 * never questioned again, because the usage log is append-only.
 *
 * Requires `usage.include` on the request, which the openrouter plugin sets at
 * bind time and `buildProviderOptions` sets for every other call site.
 */
function upstreamCostUsd(providerMetadata: SharedV4ProviderMetadata | undefined): number | undefined {
    const cost = (providerMetadata?.openrouter as { usage?: { cost?: unknown } } | undefined)?.usage?.cost;

    if (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0) {
        return undefined;
    }

    return cost;
}

/**
 * Log the call's token usage and record it to the shared usage layer.
 *
 * `recordUsage` is fired rather than awaited: it never rejects (the guarantee is
 * enforced inside it, not assumed here) and awaiting it would put a filesystem
 * write between the provider's last token and the caller's return. A usage row
 * is accounting; the answer is the product.
 */
function logUsage({
    target,
    usage,
    costUsd,
}: {
    target: CallTarget;
    usage: LanguageModelUsage | undefined;
    costUsd?: number;
}): void {
    // The SDK always hands back a usage OBJECT; a provider that reported nothing
    // shows up as undefined token counts inside it. Both spellings mean the same
    // thing, and recording a 0/0 row for them would assert this call cost $0
    // rather than that its cost is unknown.
    if (!usage || (usage.inputTokens === undefined && usage.outputTokens === undefined)) {
        log.warn({ model: target.label }, "provider returned no usage; cost for this call cannot be attributed");
        return;
    }

    log.debug({ model: target.label, usage }, "call usage");

    const cacheRead = usageCacheReadTokens(usage);
    const cacheWrite = usageCacheWriteTokens(usage);

    void recordUsage({
        app: target.app ?? "ai-core",
        accountId: target.accountId ?? "unknown",
        provider: target.provider ?? target.providerType ?? "unknown",
        modelId: target.modelId ?? target.label,
        // NOT `usage.inputTokens`: ai@7's Anthropic provider folds cache tokens
        // into that field, so recording it as billable input charges every cached
        // token twice — once at the full rate here and once at the cache rate.
        inputTokens: usageInputNoCacheTokens(usage),
        outputTokens: usage.outputTokens ?? 0,
        // The frozen event shape has no cache columns, so the counts ride in
        // `meta` while `usage` (unstored) lets the cost use the real cache rates.
        usage,
        // An upstream-reported charge beats anything the catalog can derive, and
        // `recordUsage` marks it `costSource: "supplied"` so the two never blur.
        ...(costUsd === undefined ? {} : { costUsd }),
        ...(cacheRead > 0 || cacheWrite > 0
            ? { meta: { cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite } }
            : {}),
    });
}

/**
 * Turn whichever of `providerChoice` / `model` the caller supplied into a target.
 * Exactly one is required; naming both is a programming error rather than a
 * precedence question, because the two can disagree about which account pays.
 */
export async function resolveCallTarget(options: {
    providerChoice?: ProviderChoice;
    model?: ModelRef | ResolvedBinding;
    task?: ResolveOptions["task"];
    app?: ResolveOptions["app"];
}): Promise<CallTarget> {
    const { providerChoice, model } = options;

    if (providerChoice && model) {
        throw new Error("Pass either `providerChoice` or `model`, not both — they can name different accounts.");
    }

    if (providerChoice) {
        const providerType = providerChoice.provider.type;

        return {
            model: getLanguageModel(providerChoice.provider.provider, providerChoice.model.id, providerType),
            providerType,
            systemPromptPrefix: providerChoice.provider.systemPromptPrefix,
            label: `${providerChoice.provider.name}/${providerChoice.model.id}`,
            // This path predates account ids: `DetectedProvider` carries a human
            // account NAME. Usage rows treat the field as an opaque key, so a
            // mixed corpus groups into two buckets instead of losing rows.
            accountId: providerChoice.provider.account?.name ?? providerChoice.provider.name,
            provider: providerType,
            modelId: providerChoice.model.id,
            app: options.app,
        };
    }

    if (!model) {
        throw new Error("No model named: pass `model` (a ModelRef) or `providerChoice`.");
    }

    const selfResolved = typeof model === "string";
    const resolved = selfResolved ? await resolveModel(model, { task: options.task, app: options.app }) : model;

    return {
        model: resolved.binding.language(resolved.model.id),
        providerType: resolved.plugin.id,
        systemPromptPrefix: resolved.binding.systemPromptPrefix,
        label: `${resolved.account.name}/${resolved.model.id}`,
        accountId: resolved.account.id,
        provider: resolved.account.provider,
        modelId: resolved.model.id,
        app: options.app,
        ...(selfResolved ? { dispose: () => resolved.binding.dispose?.() } : {}),
    };
}

export async function callLLM(options: CallLLMOptions): Promise<CallLLMResult> {
    const target = await resolveCallTarget(options);

    try {
        return await runCall(target, options);
    } finally {
        // Only fires for a binding resolveCallTarget created itself; a caller
        // that passed its own ResolvedBinding keeps ownership.
        target.dispose?.();
    }
}

async function runCall(target: CallTarget, options: CallLLMOptions): Promise<CallLLMResult> {
    if (!options.streaming) {
        const result = await coreChat({
            target,
            system: options.systemPrompt,
            prompt: options.userPrompt,
            maxTokens: options.maxTokens,
            temperature: options.temperature,
            headers: options.headers,
        });

        return { content: result.content, usage: result.usage };
    }

    const stdout = options.streamTarget ?? process.stdout;
    let pipeBroken = false;

    const write = (text: string): void => {
        if (pipeBroken) {
            return;
        }

        try {
            stdout.write(text);
        } catch {
            // Downstream closed the pipe (`| head -15`). Keep accumulating the
            // text so the caller still gets a complete result.
            pipeBroken = true;
        }
    };

    const result = await coreChat({
        target,
        system: options.systemPrompt,
        prompt: options.userPrompt,
        maxTokens: options.maxTokens,
        temperature: options.temperature,
        headers: options.headers,
        stream: true,
        onChunk: write,
    });

    write("\n");

    return { content: result.content, usage: result.usage };
}

/** `callLLM`'s streaming mode with the chunks handed to a callback instead of a stream. */
export async function streamLLM(
    options: CallLLMOptions & { onChunk: (chunk: string) => void }
): Promise<CallLLMResult> {
    const target = await resolveCallTarget(options);

    try {
        const result = await coreChat({
            target,
            system: options.systemPrompt,
            prompt: options.userPrompt,
            maxTokens: options.maxTokens,
            temperature: options.temperature,
            headers: options.headers,
            stream: true,
            onChunk: options.onChunk,
        });

        return { content: result.content, usage: result.usage };
    } finally {
        target.dispose?.();
    }
}

export async function callLLMStructured<T>(options: CallLLMStructuredOptions<T>): Promise<CallLLMStructuredResult<T>> {
    const target = await resolveCallTarget(options);

    try {
        return await runStructured(target, options);
    } finally {
        target.dispose?.();
    }
}

async function runStructured<T>(
    target: CallTarget,
    options: CallLLMStructuredOptions<T>
): Promise<CallLLMStructuredResult<T>> {
    const { schema, maxTokens, temperature, onPartial } = options;

    const callArgs = {
        system: effectiveSystemPrompt(target.systemPromptPrefix, options.systemPrompt),
        prompt: options.userPrompt,
        schema,
        providerOptions: buildProviderOptions(target.providerType),
        ...(maxTokens ? { maxOutputTokens: maxTokens } : {}),
        ...(temperature !== undefined ? { temperature } : {}),
    };

    if (onPartial) {
        const streamed = await tryStreamObject<T>({ model: target.model, callArgs, onPartial });

        if (streamed) {
            return streamed;
        }
    }

    const result = await generateObject({
        model: target.model as unknown as Parameters<typeof generateObject>[0]["model"],
        ...callArgs,
    });

    return {
        object: result.object as T,
        content: SafeJSON.stringify(result.object, null, 2),
        usage: result.usage,
    };
}

interface TryStreamObjectOpts<T> {
    model: LanguageModel;
    callArgs: {
        system: string | undefined;
        prompt: string;
        schema: z.ZodType<T>;
        providerOptions: ReturnType<typeof buildProviderOptions>;
        maxOutputTokens?: number;
        temperature?: number;
    };
    onPartial: (partial: unknown) => void;
}

/**
 * Streams a structured call via `streamObject`. Returns `null` (for a silent
 * `generateObject` fallback) when the stream fails before the first chunk;
 * errors after the first chunk propagate like a failed `generateObject` call.
 */
async function tryStreamObject<T>(opts: TryStreamObjectOpts<T>): Promise<CallLLMStructuredResult<T> | null> {
    let sawChunk = false;

    try {
        const result = streamObject({
            model: opts.model as unknown as Parameters<typeof streamObject>[0]["model"],
            ...opts.callArgs,
        });

        for await (const partial of result.partialObjectStream) {
            sawChunk = true;
            opts.onPartial(partial);
        }

        const object = (await result.object) as T;

        return {
            object,
            content: SafeJSON.stringify(object, null, 2),
            usage: await result.usage,
        };
    } catch (error) {
        if (!sawChunk) {
            logger.debug({ err: error }, "streamObject failed before first chunk — falling back to generateObject");
            return null;
        }

        throw error;
    }
}
