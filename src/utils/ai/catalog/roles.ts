/**
 * The model a feature uses for a fixed job when its own config names none, per provider. A role says WHY that
 * model was picked, so the next release moves it here once, for every caller (lint-rules
 * `no-model-id-literal-outside-catalog`, .claude/rules/models.md). A job that should move with a family uses the
 * family alias instead (`resolveAnthropicSubModel("opus")`, `resolveOpenAiSubModel("sol")`); a role is for a pick
 * the family alias must not move.
 */
export const MODEL_ROLES = {
    anthropic: {
        /**
         * The cheapest model every account and tier answers, for a one-token request that only checks the account:
         * the token check, the org fingerprint and the quota-header fallback. Dated, because the API serves no bare
         * `claude-haiku-4-5`.
         */
        probe: "claude-haiku-4-5-20251001",
        /** The cheapest model every subscription tier can count tokens against (`/v1/messages/count_tokens`). */
        countTokens: "claude-sonnet-5",
    },
    openai: {
        /** A short chat reply to a person, such as the Telegram bot's answers. */
        chat: "gpt-5-chat-latest",
        /** The small, cheap text model at the end of a provider fallback chain. */
        small: "gpt-4o-mini",
    },
    xai: {
        /** Grok's model when a run or a tool names none: `tools grok run`, a grok worker, a grok task default. */
        default: "grok-4.7",
    },
} as const;
