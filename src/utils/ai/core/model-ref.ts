import { logger } from "@genesiscz/utils/logger";
import { accountRefIn, refToId } from "../config/refs";
import type { AiConfigData } from "../config/schema";

/**
 * The one string grammar every surface uses to name a model.
 *
 * Today the same intent is spelled four different ways: youtube's
 * `"provider/model"` spec, ask's bare fuzzy model name, ai-proxy's
 * `"slug/model"` and the config's `@account/...` refs. They all collapse here so
 * a ref written in one tool's config resolves identically in another.
 *
 *   <modelId>                        bare, resolved through the defaults ladder
 *   <providerId>/<modelId>           provider-scoped, that provider's default account
 *   @account/<accountId>             an account, model from the defaults ladder
 *   @account/<accountId>:<modelId>   an account and an explicit model
 *   @proxy/<slug>/<modelId>          through the local ai-proxy gateway
 *
 * Parsing is STRUCTURAL only: it says what shape the caller wrote, never whether
 * the account or model exists. Existence is `resolveModel`'s job, because that
 * is the layer that can name the command which fixes a missing one.
 */

/**
 * A model reference in the grammar above. A plain string by design — it travels
 * through config files, CLI flags and JSON payloads, and a branded type would
 * only add casts at every boundary without buying a runtime check.
 */
export type ModelRef = string;

export type ModelRefKind = "bare" | "provider" | "account" | "proxy";

export interface ParsedModelRef {
    kind: ModelRefKind;
    accountId?: string;
    /** Provider plugin id (`anthropic`, `grok-sub`, …). Free-form: plugin ids are strings. */
    providerId?: string;
    /** ai-proxy provider slug, for `@proxy/` refs. */
    slug?: string;
    modelId?: string;
    /** The `models.aliases` key that produced this parse, when one did. */
    alias?: string;
}

const ACCOUNT_PREFIX = "@account/";
const PROXY_PREFIX = "@proxy/";

const GRAMMAR = [
    "  <modelId>                        e.g. opus",
    "  <providerId>/<modelId>           e.g. anthropic/claude-opus-4-5",
    "  @account/<accountId>             e.g. @account/acc_work",
    "  @account/<accountId>:<modelId>   e.g. @account/acc_work:opus",
    "  @proxy/<slug>/<modelId>          e.g. @proxy/grok/grok-4.5",
].join("\n");

export class ModelRefError extends Error {
    constructor(
        readonly ref: string,
        problem: string
    ) {
        super(`Malformed model ref "${ref}": ${problem}.\n\nExpected one of:\n${GRAMMAR}`);
        this.name = "ModelRefError";
    }
}

/**
 * Aliases expand FIRST and exactly ONE level.
 *
 * One level rather than a chain because an alias table is user-editable and a
 * cycle there would hang resolution; one hop covers the real use ("fast" →
 * "groq/llama-3.3-70b") and a second hop is reported instead of followed.
 *
 * An alias whose key is also a provider id wins over the provider reading: the
 * user wrote the alias into their own config, so it is the more specific intent.
 */
function expandAlias(ref: string, cfg: AiConfigData): { target: string; alias?: string } {
    const aliases = cfg.models?.aliases;
    const expansion = aliases?.[ref]?.trim();

    if (!expansion) {
        return { target: ref };
    }

    const { log } = logger.scoped("ai-core");

    if (aliases?.[expansion] !== undefined) {
        log.warn(
            { alias: ref, expansion },
            "model alias expands to another alias; only one level is followed, so the expansion is used verbatim"
        );
    }

    log.debug({ alias: ref, expansion }, "expanded model alias");
    return { target: expansion, alias: ref };
}

export function parseModelRef(ref: string, cfg: AiConfigData): ParsedModelRef {
    const raw = ref.trim();

    if (!raw) {
        throw new ModelRefError(ref, "the ref is empty");
    }

    const { target, alias } = expandAlias(raw, cfg);

    if (target.startsWith(PROXY_PREFIX)) {
        return parseProxyRef(ref, target, alias);
    }

    if (target.startsWith(ACCOUNT_PREFIX)) {
        return parseAccountRef(ref, target, alias);
    }

    if (target.startsWith("@")) {
        throw new ModelRefError(ref, `"${target.split("/")[0]}" is not a known ref namespace (@account, @proxy)`);
    }

    const slash = target.indexOf("/");

    if (slash === -1) {
        return { kind: "bare", modelId: target, ...(alias ? { alias } : {}) };
    }

    // Split on the FIRST slash so provider-prefixed model ids (openrouter's
    // "anthropic/claude-3.5-sonnet") survive as the model half.
    const providerId = target.slice(0, slash);
    const modelId = target.slice(slash + 1);

    if (!providerId) {
        throw new ModelRefError(ref, "the provider id before the slash is empty");
    }

    if (!modelId) {
        throw new ModelRefError(ref, "the model id after the slash is empty");
    }

    return { kind: "provider", providerId, modelId, ...(alias ? { alias } : {}) };
}

function parseProxyRef(ref: string, target: string, alias?: string): ParsedModelRef {
    const rest = target.slice(PROXY_PREFIX.length);
    const slash = rest.indexOf("/");

    if (slash === -1) {
        throw new ModelRefError(ref, "a proxy ref needs both a slug and a model id");
    }

    const slug = rest.slice(0, slash);
    const modelId = rest.slice(slash + 1);

    if (!slug) {
        throw new ModelRefError(ref, "the proxy slug is empty");
    }

    if (!modelId) {
        throw new ModelRefError(ref, "the model id after the proxy slug is empty");
    }

    return { kind: "proxy", slug, modelId, ...(alias ? { alias } : {}) };
}

function parseAccountRef(ref: string, target: string, alias?: string): ParsedModelRef {
    // `accountRefIn` already knows a ModelRef may embed an account ref and splits
    // the `:model` suffix off. Reused rather than re-split so the two stay in
    // agreement; note that `accountRefSchema` REJECTS the suffix and must never
    // be used to validate a ModelRef.
    const accountRef = accountRefIn(target);

    if (!accountRef) {
        throw new ModelRefError(ref, "the account id after @account/ is empty");
    }

    const accountId = refToId(accountRef);
    const rest = target.slice(ACCOUNT_PREFIX.length);
    const colon = rest.indexOf(":");

    if (colon === -1) {
        return { kind: "account", accountId, ...(alias ? { alias } : {}) };
    }

    const modelId = rest.slice(colon + 1);

    if (!modelId) {
        throw new ModelRefError(ref, "the model id after the colon is empty");
    }

    return { kind: "account", accountId, modelId, ...(alias ? { alias } : {}) };
}

/** Render a parsed ref back to its canonical string, for logs and error text. */
export function formatModelRef(parsed: ParsedModelRef): string {
    switch (parsed.kind) {
        case "bare":
            return parsed.modelId ?? "";
        case "provider":
            return `${parsed.providerId}/${parsed.modelId}`;
        case "account":
            return parsed.modelId
                ? `${ACCOUNT_PREFIX}${parsed.accountId}:${parsed.modelId}`
                : `${ACCOUNT_PREFIX}${parsed.accountId}`;
        case "proxy":
            return `${PROXY_PREFIX}${parsed.slug}/${parsed.modelId}`;
    }
}
