/**
 * Subscription OAuth Billing Header
 *
 * When using Claude subscription OAuth tokens (Bearer auth) to call the
 * Anthropic Messages API, non-Haiku models (Sonnet, Opus) require a
 * "billing header" as the first text block in the system prompt array.
 * Without it, the API returns 400 invalid_request_error "Error".
 *
 * The billing header is NOT an HTTP header — it's a computed text block
 * injected as system[0] containing a version hash and content hash.
 *
 * Algorithm (reverse-engineered from Claude Code cli.js v2.1.78):
 *   - cch = SHA-256(first_user_message)[:5]
 *   - sampled = chars at positions 4, 7, 20 of first user message (or "0")
 *   - version_hash = SHA-256(SALT + sampled + VERSION)[:3]
 *   - Format: "x-anthropic-billing-header: cc_version=VERSION.hash; cc_entrypoint=cli; cch=XXXXX;"
 *
 * Sources:
 *   - Claude Code cli.js function g21() / $O8() / rW7()
 *   - https://gist.github.com/NTT123/579183bdd7e028880d06c8befae73b99
 *   - https://github.com/anthropics/claude-code/issues/35724
 *   - https://github.com/anthropics/claude-code-action/issues/928
 *
 * Required beta headers: oauth-2025-04-20, claude-code-20250219
 * Required system prompt prefix: "You are Claude Code, Anthropic's official CLI for Claude."
 */
import { createHash } from "node:crypto";
import { SafeJSON } from "@app/utils/json";

const BILLING_SALT = "59cf53e54c78";
const CC_VERSION = "2.1.78";

/** System prompt line required by subscription OAuth API. */
export const SUBSCRIPTION_SYSTEM_PREFIX = "You are Claude Code, Anthropic's official CLI for Claude.";

/** Beta flags required for subscription OAuth. */
export const SUBSCRIPTION_BETAS = "oauth-2025-04-20,claude-code-20250219";

export function computeBillingHeader(firstUserMessage: string): string {
    const cch = createHash("sha256").update(firstUserMessage).digest("hex").slice(0, 5);
    const sampled = [4, 7, 20].map((i) => firstUserMessage[i] || "0").join("");
    const versionHash = createHash("sha256").update(`${BILLING_SALT}${sampled}${CC_VERSION}`).digest("hex").slice(0, 3);

    return `x-anthropic-billing-header: cc_version=${CC_VERSION}.${versionHash}; cc_entrypoint=cli; cch=${cch};`;
}

interface AnthropicRequestBody {
    system?: string | Array<{ type: string; text: string; cache_control?: unknown }>;
    messages?: Array<{ role: string; content: string | Array<{ type: string; text?: string }> }>;
    [key: string]: unknown;
}

/**
 * Inject the billing header as system[0] for subscription OAuth requests.
 * Parses the JSON body, extracts first user message for hash, prepends block.
 */
export function injectBillingHeader(bodyStr: string): string {
    const body = SafeJSON.parse(bodyStr) as AnthropicRequestBody;

    const firstUserMsg = body.messages?.find((m) => m.role === "user");
    let firstUserText = "";

    if (firstUserMsg) {
        if (typeof firstUserMsg.content === "string") {
            firstUserText = firstUserMsg.content;
        } else if (Array.isArray(firstUserMsg.content)) {
            const textBlock = firstUserMsg.content.find((b) => b.type === "text");
            firstUserText = textBlock?.text ?? "";
        }
    }

    const billingText = computeBillingHeader(firstUserText);

    if (typeof body.system === "string") {
        body.system = [{ type: "text", text: body.system }];
    } else if (!Array.isArray(body.system)) {
        body.system = [];
    }

    body.system.unshift({ type: "text", text: billingText });
    return SafeJSON.stringify(body);
}

/**
 * Prepend system prompt prefix if present.
 * Used by both `tools ask` and `tools claude summarize`.
 */
export function applySystemPromptPrefix(prefix: string | undefined, basePrompt: string): string {
    if (!prefix) {
        return basePrompt;
    }

    return `${prefix}\n\n${basePrompt}`;
}

/**
 * Create a fetch wrapper that:
 * 1. Strips x-api-key (SDK injects it, but OAuth uses Bearer only)
 * 2. Injects billing header as system[0] (required for Sonnet/Opus)
 */
export function createSubscriptionFetch(): typeof fetch {
    return ((url: RequestInfo | URL, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        headers.delete("x-api-key");

        let body = init?.body;

        if (typeof body === "string") {
            try {
                body = injectBillingHeader(body);
            } catch (err) {
                console.warn(
                    "[subscription-billing] Failed to inject billing header — Sonnet/Opus may return 400:",
                    err
                );
            }
        }

        return globalThis.fetch(url, { ...init, body, headers });
    }) as typeof fetch;
}
