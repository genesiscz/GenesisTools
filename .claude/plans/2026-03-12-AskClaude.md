# Ask Tool: Claude Provider + Config + Model Selection Fix

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.
> **Also save to:** `.claude/plans/2026-03-12-AskClaude.md` at implementation start.

**Goal:** (1) Add Claude/Anthropic subscription-based auth to the ask tool's anthropic provider, (2) add persistent config with interactive `tools ask configure`, (3) fix `tools github get` for tree URLs, (4) fix OpenAI model selection to exclude non-chat models and add smart API endpoint routing.

**Architecture:** Merge subscription token support into the existing `anthropic` provider. Config at `~/.genesis-tools/ask/config.json`. Footer shows `Provider: anthropic (pro) · martin`. Smart model routing uses `.chat()` for chat models, `.responses()` for codex/pro models, with fallback detection.

**Tech Stack:** TypeScript, Bun, @clack/prompts, @ai-sdk/openai, @ai-sdk/anthropic, existing OAuth from `src/utils/claude/auth.ts`

---

## Part 0: Branch Setup

### Task 0.1: Create branch
```bash
git checkout master && git checkout -b feat/ask-updates --no-track
```

---

## Part 1: Fix `tools github get` for Tree URLs

### Task 1.1: Extend URL parser for tree URLs

**Files:**
- Modify: `src/utils/github/url-parser.ts:205`

**What:** Change the blob/blame regex to also match `tree`:
```typescript
const githubMatch = input.match(/github\.com\/([^/]+)\/([^/]+)\/(?:blob|blame|tree)\/([^/]+)\/(.+)/);
```

Add `isDirectory?: boolean` to the `GitHubFileUrl` interface. Set it when the URL contains `/tree/`.

### Task 1.2: Handle directory listing in get command

**Files:**
- Modify: `src/github/commands/get.ts`

**What:** When `parsed.isDirectory` is true (or when `Array.isArray(data)` from octokit):
1. Don't throw on array response - iterate it
2. For each file entry in the directory listing, fetch content via raw URL
3. Concatenate all files with `--- FILE: path/to/file ---` headers
4. Support `--output <dir>` to write files to a local directory
5. Update the help text to list tree URL format

**Key detail:** `octokit.rest.repos.getContent()` returns `Array<{ name, path, type, size, download_url }>` for directories. Filter to `type === "file"`, fetch each via `download_url`, concatenate.

### Task 1.3: Commit
```bash
git commit -m "feat(github): support tree/directory URLs in get command"
```

---

## Part 2: Subscription Auth Module

### Task 2.1: Try fetching LEFTEQ package
```bash
tools github get https://github.com/LEFTEQ/Tools/tree/main/packages/anthropic-subscription-auth/src
```
If 404/private, proceed to Task 2.2 using existing `src/utils/claude/auth.ts` as the foundation.

### Task 2.2: Create subscription auth bridge

**Files:**
- Create: `src/utils/claude/subscription-auth.ts`
- **DO NOT modify** `src/utils/claude/auth.ts`

**What:** Bridge between `tools claude` account system and `tools ask`:

```typescript
import { claudeOAuth, fetchOAuthProfile, getKeychainCredentials } from "./auth";
import { loadConfig, withConfigLock, type AccountConfig } from "@app/claude/lib/config";

interface SubscriptionAccount {
    name: string;
    label?: string;
    accessToken: string;
    refreshToken?: string;
    expiresAt?: number;
}

/** List all accounts from tools claude config */
export async function listAvailableAccounts(): Promise<SubscriptionAccount[]>

/** Resolve a valid token for a given account (auto-refreshes if expired) */
export async function resolveAccountToken(accountName?: string): Promise<{ token: string; account: SubscriptionAccount }>

/** Get account display info for footer */
export async function getAccountDisplayInfo(accountName?: string): Promise<{ label?: string; name: string } | null>
```

**Critical detail - token refresh:** The refresh token is single-use. `resolveAccountToken` must:
1. Acquire config lock via `withConfigLock()`
2. Check `claudeOAuth.needsRefresh(expiresAt)`
3. If expired, call `claudeOAuth.refresh(refreshToken)`
4. Save new tokens back to claude config under the lock
5. Return the fresh access token

This is already the pattern used in `src/claude/lib/usage/api.ts` - reuse that logic.

### Task 2.3: Commit
```bash
git commit -m "feat(claude): add subscription auth module for ask tool integration"
```

---

## Part 3: Ask Config System

### Task 3.1: Define config types

**Files:**
- Modify: `src/ask/types/config.ts`

**What:** Extend `AppConfig`:
```typescript
export interface AskConfig extends AppConfig {
    // Claude subscription config
    claude?: {
        accountRef?: string;        // tools claude account name (e.g. "martin")
        independentToken?: string;  // Standalone OAuth token (not linked to tools claude)
        accountLabel?: string;      // Cached label for footer (e.g. "pro")
        accountName?: string;       // Cached account key for footer (e.g. "martin")
    };

    // Provider token control
    envTokens?: {
        enabled: boolean;           // Master switch (default true)
        disabledProviders?: string[];
    };
}
```

Note: `defaultProvider`, `defaultModel`, `temperature`, `maxTokens`, `streaming` are already on `AppConfig`.

### Task 3.2: Create config storage

**Files:**
- Create: `src/ask/config/index.ts`

**What:**
```typescript
import { Storage } from "@app/utils/storage/storage";
import type { AskConfig } from "@ask/types/config";

const storage = new Storage("ask");
const DEFAULT: AskConfig = { envTokens: { enabled: true } };

export async function loadAskConfig(): Promise<AskConfig> {
    const saved = await storage.getConfig<Partial<AskConfig>>();
    return { ...DEFAULT, ...saved, envTokens: { ...DEFAULT.envTokens, ...saved?.envTokens } };
}
export async function saveAskConfig(config: AskConfig): Promise<void> {
    await storage.setConfig(config);
}
```

### Task 3.3: Create configure command

**Files:**
- Create: `src/ask/commands/configure.ts`

**What:** Interactive clack wizard. Main menu:
1. **Use tools claude account** → list accounts from `listAvailableAccounts()`, pick one, save `claude.accountRef`, cache label/name
2. **Auth with Anthropic subscription** → full OAuth flow (reuse pattern from `src/claude/commands/config.ts`: `generateAuthUrl` → `presentAuthUrl` → `promptAndExchangeCode` → save independent token). At end, offer to copy to `tools claude` config
3. **Configure independently** → paste manual API key or OAuth token
4. **Provider settings** → toggle env tokens master switch + per-provider toggles
5. **Default model** → pick provider, then pick model (reuse `ModelSelector`)
6. **Show config** → display current settings in `p.note()`

**Option 1 detail (Use tools claude account):**
```typescript
const accounts = await listAvailableAccounts();
if (accounts.length === 0) {
    p.log.warn("No accounts configured. Run `tools claude login` first.");
    return;
}
const choice = await p.select({
    message: "Which account?",
    options: accounts.map(a => ({
        value: a.name,
        label: `${a.name}${a.label ? ` (${a.label})` : ""}`,
    })),
});
config.claude = { accountRef: choice, accountLabel: acc.label, accountName: choice };
```

**Option 2 detail (Auth with Anthropic subscription):**
At end, after saving the independent token:
```typescript
const copyToClaude = await p.confirm({
    message: "Copy this account to `tools claude` for usage monitoring?",
    initialValue: true,
});
if (copyToClaude) {
    // Save to claude config using saveConfig from @app/claude/lib/config
    p.note(
        "tools claude usage - Monitor your Claude subscription usage\n" +
        "tools claude usage watch - Live dashboard with notifications",
        "What tools claude can do"
    );
}
```

### Task 3.4: Wire into ask tool entry point

**Files:**
- Modify: `src/ask/index.ts`

**What:** Add routing before the `models` check:
```typescript
if (firstArg === "configure" || firstArg === "config") {
    const { runConfigureWizard } = await import("@ask/commands/configure");
    await runConfigureWizard();
    return;
}
```

### Task 3.5: Apply config defaults early in main()

**Files:**
- Modify: `src/ask/index.ts`

**What:** After parsing argv, before validation, load config and apply defaults:
```typescript
const askConfig = await loadAskConfig();
if (!argv.provider && askConfig.defaultProvider) {
    argv.provider = askConfig.defaultProvider;
}
if (!argv.model && askConfig.defaultModel) {
    argv.model = askConfig.defaultModel;
}
```

### Task 3.6: Commit
```bash
git commit -m "feat(ask): add interactive configuration wizard and config defaults"
```

---

## Part 4: Enhance Anthropic Provider with Subscription Tokens

### Task 4.1: Modify provider detection

**Files:**
- Modify: `src/ask/providers/ProviderManager.ts`

**What:** In `detectProviders()`, after the normal env-key loop, add special handling for anthropic subscription:

```typescript
// After the main loop, check for subscription token if anthropic wasn't detected via env
if (!this.detectedProviders.has("anthropic")) {
    const askConfig = await loadAskConfig();
    if (askConfig.claude?.accountRef || askConfig.claude?.independentToken) {
        const { resolveAccountToken } = await import("@app/utils/claude/subscription-auth");
        try {
            const { token, account } = await resolveAccountToken(askConfig.claude.accountRef);
            const { createAnthropic } = await import("@ai-sdk/anthropic");
            const provider = createAnthropic({ apiKey: token });
            // ... create DetectedProvider with provider, models from KNOWN_MODELS.anthropic
        } catch (e) { /* log and skip */ }
    }
}
```

**Critical detail:** `@ai-sdk/anthropic`'s `createAnthropic()` accepts `{ apiKey }` which is used as the Bearer token. OAuth subscription tokens work the same way as API keys for the inference endpoint - both go in the `x-api-key` or `Authorization` header. Verify this works by checking the SDK source.

**Also check:** If `ANTHROPIC_API_KEY` IS set but the user configured a subscription account, should subscription take priority? Yes - the config is the user's explicit choice. Handle by checking config first:
```typescript
// In the main loop, before checking env key for anthropic:
if (config.name === "anthropic" && askConfig.claude?.accountRef) {
    // Skip env key, subscription will be added after the loop
    continue;
}
```

### Task 4.2: Respect env token control

**Files:**
- Modify: `src/ask/providers/ProviderManager.ts`

**What:** At the top of `detectProviders()`:
```typescript
const askConfig = await loadAskConfig();
// In the loop:
if (askConfig.envTokens?.enabled === false) continue;
if (askConfig.envTokens?.disabledProviders?.includes(config.name)) continue;
```

### Task 4.3: Update known models list

**Files:**
- Modify: `src/ask/providers/providers.ts`

**What:** Add latest Claude models:
```typescript
anthropic: [
    { id: "claude-sonnet-4-20250514", name: "Claude Sonnet 4", contextWindow: 200000, capabilities: ["chat", "vision", "function-calling"] },
    { id: "claude-opus-4-20250514", name: "Claude Opus 4", contextWindow: 200000, capabilities: ["chat", "vision", "function-calling"] },
    { id: "claude-haiku-4-5-20251001", name: "Claude Haiku 4.5", contextWindow: 200000, capabilities: ["chat", "vision", "function-calling"] },
    // Keep existing ones
    { id: "claude-3-5-sonnet-20241022", ... },
    { id: "claude-3-opus-20240229", ... },
    { id: "claude-3-sonnet-20240229", ... },
    { id: "claude-3-haiku-20240307", ... },
]
```

### Task 4.4: Commit
```bash
git commit -m "feat(ask): enhance anthropic provider with subscription token + latest models"
```

---

## Part 5: Footer Enhancement

### Task 5.1: Add account info to cost breakdown

**Files:**
- Modify: `src/ask/output/OutputManager.ts`

**What:** Extend `formatCostBreakdown` signature:
```typescript
async formatCostBreakdown(
    breakdowns: Array<{ ... }>,
    accountInfo?: { label?: string; name: string }
): Promise<string>
```

At the end of the formatted output, if `accountInfo` is present:
```typescript
if (accountInfo) {
    const labelPart = accountInfo.label ? ` (${accountInfo.label})` : "";
    output += pc.dim(`Provider: ${breakdowns[0].provider}${labelPart} · ${accountInfo.name}\n`);
}
```

### Task 5.2: Pass account info through from index.ts

**Files:**
- Modify: `src/ask/index.ts`

**What:** In both `handleSingleMessage` and `startInteractiveChat`, when showing cost breakdown:
```typescript
const askConfig = await loadAskConfig();
const accountInfo = askConfig.claude?.accountName
    ? { label: askConfig.claude.accountLabel, name: askConfig.claude.accountName }
    : undefined;
console.log(await outputManager.formatCostBreakdown(breakdown, accountInfo));
```

### Task 5.3: Commit
```bash
git commit -m "feat(ask): show account info in footer + config defaults"
```

---

## Part 6: Fix OpenAI Model Selection (Non-Chat Models)

### Task 6.1: Improve model filtering

**Files:**
- Modify: `src/ask/providers/ProviderManager.ts`

**What:** The current filter fails because `gpt-5.2-codex` matches `gpt-` prefix but is NOT a chat model. The `@ai-sdk/openai` SDK defines separate types:
- `OpenAIChatModelId` — models for `/v1/chat/completions`
- `OpenAIResponsesModelId` — superset including codex/pro (Responses API)
- `OpenAICompletionModelId` — legacy completions

Fix the filter with a whitelist+exclusion approach:
```typescript
// Known chat model prefixes (from @ai-sdk/openai OpenAIChatModelId)
const chatModelPrefixes = [
    "gpt-3.5-turbo", "gpt-4", "gpt-4o", "gpt-4-turbo",
    "gpt-4.1", "gpt-4.5", "gpt-5-mini", "gpt-5-nano",
    "gpt-5-chat", "gpt-5-2025", "gpt-5",
    "o1", "o3", "chatgpt-",
];

// Models that match gpt- prefix but are NOT chat models
const nonChatPatterns = [
    "codex",       // gpt-5-codex, gpt-5.2-codex — code execution models
    "-pro",        // gpt-5-pro — specialized, responses-only
    "instruct",    // gpt-3.5-turbo-instruct — legacy completion
    "image",       // gpt-image-1 — image generation
    "transcribe",  // gpt-4o-transcribe — audio
    "tts",         // gpt-4o-mini-tts — speech
];

const chatModels = data.data.filter(model => {
    const id = model.id.toLowerCase();
    // Must NOT match any non-chat pattern
    if (nonChatPatterns.some(p => id.includes(p))) return false;
    // Must match a known chat prefix
    return chatModelPrefixes.some(prefix => id.startsWith(prefix));
});
```

### Task 6.2: Smart API endpoint routing in getLanguageModel

**Files:**
- Modify: `src/ask/types/provider.ts`

**What:** The current `getLanguageModel` always uses `.chat()`. Add intelligence:

```typescript
// Known non-chat model patterns that need .responses() instead of .chat()
const RESPONSES_ONLY_PATTERNS = ["codex", "-pro"];

export function getLanguageModel(provider: ProviderV2, modelId: string): LanguageModel {
    const id = modelId.toLowerCase();

    // For OpenAI provider: route to correct API endpoint
    if ("chat" in provider && "responses" in provider && typeof provider.responses === "function") {
        // Check if this model needs the Responses API
        if (RESPONSES_ONLY_PATTERNS.some(p => id.includes(p))) {
            // Use Responses API for codex/pro models
            return (provider.responses as (id: string) => LanguageModel)(modelId);
        }
        // Default to Chat API for normal chat models
        return (provider.chat as (id: string) => LanguageModel)(modelId);
    }

    // For non-OpenAI providers, use .languageModel() as fallback
    return provider.languageModel(modelId);
}
```

Add a clear comment block explaining the decision:
```typescript
/**
 * OpenAI has 3 text generation API endpoints:
 *
 * 1. /v1/chat/completions (Chat API) — Used by .chat()
 *    Models: gpt-4o, gpt-4-turbo, gpt-3.5-turbo, o1, o3, gpt-5, etc.
 *    This is the default and most common endpoint.
 *
 * 2. /v1/responses (Responses API) — Used by .responses() / .languageModel()
 *    Models: Everything in Chat API + gpt-5-codex, gpt-5-pro
 *    Newer API with tool results, web search, etc.
 *    Warning: .languageModel() defaults here in ai-sdk v5+
 *
 * 3. /v1/completions (Completions API) — Used by .completion()
 *    Models: gpt-3.5-turbo-instruct only (legacy)
 *
 * We prefer .chat() because it's the most established and widely tested.
 * Models like gpt-5-codex/gpt-5-pro ONLY work on Responses API.
 * See: src/ask/docs/selecting-mode-decision.md for full details.
 */
```

### Task 6.3: Create decision documentation

**Files:**
- Create: `src/ask/docs/selecting-mode-decision.md`

**What:** Detailed explanation of OpenAI's 3 API endpoints, which models go where, how the ask tool decides, and the fallback strategy.

**Contents outline:**
1. **The 3 OpenAI Text Generation Endpoints** — Chat Completions, Responses, Legacy Completions
2. **Model → Endpoint Mapping** — table of which models work on which endpoints
3. **How the Ask Tool Decides** — the `getLanguageModel` decision tree
4. **Why `.chat()` is the Default** — battle-tested, well-documented, stable
5. **When `.responses()` is Used** — codex models (code execution), pro models
6. **Known Non-Chat Patterns** — codex, pro, instruct, image, tts, transcribe
7. **Updating for New Models** — how to add new patterns when OpenAI releases models
8. **The `(string & {})` Escape Hatch** — why the SDK types accept any string but that doesn't mean all strings work on all endpoints

### Task 6.4: Commit
```bash
git commit -m "fix(ask): filter non-chat OpenAI models and route to correct API endpoint"
```

---

## Verification

1. **GitHub get tree URL:**
   ```bash
   tools github get https://github.com/vercel/ai/tree/main/packages/openai/src
   ```
   Expected: Outputs all files in that directory

2. **Ask configure wizard:**
   ```bash
   tools ask config
   ```
   Expected: Shows 6-option menu, all flows work

3. **Ask with subscription defaults:**
   ```bash
   # After configuring via tools ask config:
   tools ask "Hello, what model are you?"
   ```
   Expected: Uses configured default provider/model, footer shows `Provider: anthropic (pro) · martin`

4. **Model filtering:**
   ```bash
   tools ask models -p openai
   ```
   Expected: `gpt-5.2-codex` and similar non-chat models are NOT listed

5. **Codex model routing (if user explicitly picks one):**
   ```bash
   tools ask -p openai -m gpt-5-codex "write hello world"
   ```
   Expected: Routes to Responses API, works without 404 error

6. **Env token control:**
   ```bash
   tools ask config  # Disable env tokens for openai
   tools ask         # Interactive mode should not show openai
   ```

---

## Critical Files Reference

| File | Role |
|------|------|
| `src/utils/claude/auth.ts` | OAuth client — **DO NOT MODIFY** |
| `src/utils/claude/subscription-auth.ts` | **NEW** — subscription auth bridge |
| `src/claude/lib/config/index.ts` | Claude config (loadConfig, saveConfig, withConfigLock) |
| `src/ask/types/config.ts` | Ask config types (extend AppConfig) |
| `src/ask/config/index.ts` | **NEW** — Ask config storage |
| `src/ask/commands/configure.ts` | **NEW** — Configure wizard |
| `src/ask/index.ts` | Main entry, routing, config defaults |
| `src/ask/providers/providers.ts` | Provider configs + known models |
| `src/ask/providers/ProviderManager.ts` | Provider detection + creation + model filtering |
| `src/ask/types/provider.ts` | `getLanguageModel()` — API endpoint routing |
| `src/ask/output/OutputManager.ts` | Footer/cost display |
| `src/ask/docs/selecting-mode-decision.md` | **NEW** — Model selection docs |
| `src/utils/github/url-parser.ts` | GitHub URL parsing |
| `src/github/commands/get.ts` | GitHub get command |
| `src/utils/storage/storage.ts` | Storage class (reuse) |
| `src/utils/prompts/clack/helpers.ts` | Clack prompt helpers (reuse) |

---

## Separate Plan: Claude Learnings Extraction

A separate plan will be written to `.claude/plans/2026-03-12-ClaudeLearnings.md` for adding a `--mode learnings` to `tools claude history summarize`. This feature extracts benchmarks, findings, and actionable insights into structured tables. Same branch (`feat/ask-updates`).
