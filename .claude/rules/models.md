---
paths:
  - "src/utils/ai/catalog/**"
  - "src/utils/ai/anthropic/**"
  - "src/utils/ai/openai/sub-models*.ts"
  - "src/utils/ai/grok/models*.ts"
  - "src/ai-proxy/lib/billing/**"
  - "src/ai-proxy/lib/translators/**"
  - "src/ai-proxy/lib/reasoning-effort-vocab*.ts"
  - "src/claude/lib/models*.ts"
  - "scripts/ai/**"
  - "plugins/genesis-tools/skills/handoff-to/**"
---

# Models and pricing: where each fact lives

Loaded by Claude Code when you read, write or edit a model list, a price table or a request translator. Read it before you add a model or change a price, so a new model reaches every surface in one change.

## One source of truth

`src/utils/ai/catalog/static.ts` (`STATIC_CATALOG`) holds every model fact: id, family, display name, context window, thinking mode, aliases, release date, and pricing. Pricing carries `rules` for a context band (`ctxFrom`), a service tier (`serviceTier: "priority"` or `"fast"`) and a date window (`from` / `to`, inclusive UTC dates). `effectivePricing()` applies the rules in order, and a rule overrides only the fields it names.

These read the catalog and need no edit of their own:

- `tools claude start -m` and its alias matching (`src/claude/lib/models.ts`): an Anthropic entry appears there only when it carries `flags.cli`. `flags.native1m` marks a 1M base window, and `flags.supports1m` marks a model that takes the `[1m]` suffix.
- The Claude subscription model list and aliases (`src/utils/ai/anthropic/models.ts`, `ANTHROPIC_SUB_STATIC_CATALOG`, `resolveAnthropicSubModel`).
- Cost estimates in `tools ask`, ai-spend and usage (`pricingFor()`: static, then LiteLLM, then OpenRouter).

## Lists that are not derived from the catalog

- **Codex subscription (WHAM) slugs and the `astra` / `sol` / `luna` / `terra` aliases**: `src/utils/ai/openai/sub-models.ts`. The catalog derives its `openai-sub` entries from this list. Direct OpenAI API prices still go in `static.ts` under `openai`.
- **Grok**: `src/utils/ai/grok/models.ts` (`GROK_STATIC_CATALOG`, windows, probe seeds). The catalog derives its `xai` entries from it; `static.ts` adds windows, vision, thinking and the prices that LiteLLM and OpenRouter do not have (`XAI_PRICING`).
- **The proxy invoice ledger**: `src/ai-proxy/lib/billing/pricing.ts` (`RATE_GROUPS`). It is separate on purpose: cost is booked at write time, so an edit never rewrites a past invoice. Input and output only, with `contextFrom` for a long-context band. A new model needs a row here, or the ledger records $0. `pricing.test.ts` fails when an advertised Claude or Grok model has no row; nothing checks the Codex and OpenAI rows, so add those by hand.
- **Claude request rules**: `anthropicRequestRules()` in `src/utils/ai/anthropic/models.ts` decides per model version whether a request may carry budget or adaptive thinking, `temperature` / `top_p`, a forced `tool_choice`, an assistant prefill, and which effort ceiling applies. The proxy translator (`src/ai-proxy/lib/translators/formats/anthropic/`) asks it before it emits a field, because the API answers a forbidden field with HTTP 400. A new Claude version needs its row checked against the vendor's migration guide.
- **xAI reasoning effort**: `src/ai-proxy/lib/reasoning-effort-vocab.ts` lists which effort values each grok family accepts.
- **The OpenRouter snapshot**: `src/utils/ai/catalog/data/openrouter-snapshot.json`, refreshed with `bun scripts/ai/update-openrouter-snapshot.ts`. A diff there is a price change; read it before you commit.
- **The handoff-to skill rankings**: `plugins/genesis-tools/skills/handoff-to/SKILL.md` and `references/codex.md`. Changing them bumps the plugin version (`.claude/rules/plugins.md`).

## Lint

Three lint rules keep model facts in the owners above, each with a list in `scripts/ci/model-facts-ratchet.ts` that
only shrinks (2026-10-25): `no-model-id-literal-outside-catalog` (a whole literal that is a model id), `no-model-price-table`
(`opus: { input: … }`) and `no-effort-vocabulary-list` (an array or union of effort words). A list of efforts for one
provider is `effortRange(from, to)` or a filter of `REASONING_EFFORTS` (`src/utils/ai/catalog/efforts.ts`).

## Checklist for a new model or a price change

1. Read the vendor's own page, not a blog: the model page (`platform.claude.com/docs/en/models/<model>`, `developers.openai.com/api/docs/models/<id>`, `docs.x.ai/developers/<model>`) and the vendor pricing page. Note the date you read it in the code comment.
2. Add or change the `static.ts` entry: window, thinking mode, every price field (input, output, cache read, cache write), each context band, each fast or priority tier, and any dated rule. Move a family alias (`opus`, `sonnet`, `haiku`, `fable`, `sol`, `luna`) to the new model; exactly one entry may carry an alias.
3. Add the ledger row in `billing/pricing.ts`.
4. For Claude, check `anthropicRequestRules()` against the migration guide. For grok, check the effort vocabulary. For Codex, add the slug to `sub-models.ts` and move its alias.
5. Refresh the OpenRouter snapshot and read the price diff.
6. Update the handoff-to rankings when the model is one an agent should pick.
7. Run `bun scripts/test.ts src/utils/ai/catalog src/ai-proxy/lib/billing src/ai-proxy/lib/translators src/claude/lib/models.test.ts`, then one live call through the real account (`./tools ask -p <provider> -m <id> "..."` from the worktree).

## Traps

- `byId(id)` without a provider can return the `openai-sub` entry, which has no prices. Pass the provider (`byId("gpt-6.1-sol", "openai")`) when you need a price.
- A rule that bills a band applies to the WHOLE request once the prompt crosses the threshold (OpenAI above 272K, xAI and Sonnet 4.5 above 200K, Haiku 5.5 above 100K; Opus, Sonnet and Fable 5.x price their 1M window flat). Model it as a rule, not as a price for the excess only.
- Model id spelling differs per route: Anthropic uses `claude-sonnet-5-5`, OpenRouter uses `anthropic/claude-sonnet-5.5`.
- `src/claude-history-dashboard/src/components/stats/TokenUsageCard.tsx` still has its own family rate table. It is older than the catalog and does not follow these rules.
