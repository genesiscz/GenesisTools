# Subscription OAuth & Utility Relocation Refactor

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Extract subscription OAuth billing header logic to shared utilities, DRY subscription auth across `src/ask` and `src/claude`, relocate misplaced utilities, and fix `claude tail` user message truncation.

**Architecture:** The billing header computation (required by Anthropic API for Sonnet/Opus on subscription OAuth) currently lives inline in `ProviderManager.ts`. It should be extracted to `src/utils/claude/subscription-billing.ts` as a documented, reusable module. The custom fetch wrapper and system prompt prefix logic should also be shared so any tool using subscription auth (ask, summarize, future tools) gets it automatically. Misplaced utilities get relocated to their correct homes per project conventions.

**Tech Stack:** TypeScript, Bun, `@ai-sdk/anthropic`, SHA-256 (Node crypto)

---

## Pushback Notes

- **`ModelManager.ts` rename**: After exploration, `ModelManager` manages HuggingFace model downloads/cache lifecycle — it's NOT a provider. "LocalModelProvider" or "HFLocalModelProvider" would be misleading. **Recommend keeping current name.** If you disagree, rename is trivial and included as optional Task 10.
- **`src/ai/` refactor to `src/ai/commands/`**: `src/ai/index.ts` is a 690-line standalone CLI tool (not a plugin-style tool with subcommands). It has no commands/ directory. Refactoring it would mean splitting a monolith — valid but a separate effort. **Not included in this plan.**
- **`detectAnthropicSubscription` efficiency**: It only runs if `accountRef` or `independentToken` is configured in ask config. If neither is set, it's a no-op. The real cost is token resolution + provider creation when using `--provider openai`. Fix: skip when user explicitly targets non-anthropic provider.

---

### Task 1: Extract billing header to `src/utils/claude/subscription-billing.ts`

**Files:**
- Create: `src/utils/claude/subscription-billing.ts`
- Modify: `src/ask/providers/ProviderManager.ts` (remove inline billing code)

**Step 1: Create `src/utils/claude/subscription-billing.ts`**

```typescript
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

const BILLING_SALT = "59cf53e54c78";
const CC_VERSION = "2.1.78";

/** System prompt line required by subscription OAuth API. */
export const SUBSCRIPTION_SYSTEM_PREFIX = "You are Claude Code, Anthropic's official CLI for Claude.";

/** Beta flags required for subscription OAuth. */
export const SUBSCRIPTION_BETAS = "oauth-2025-04-20,claude-code-20250219";

export function computeBillingHeader(firstUserMessage: string): string {
    const cch = createHash("sha256").update(firstUserMessage).digest("hex").slice(0, 5);
    const sampled = [4, 7, 20].map((i) => firstUserMessage[i] || "0").join("");
    const versionHash = createHash("sha256")
        .update(`${BILLING_SALT}${sampled}${CC_VERSION}`)
        .digest("hex")
        .slice(0, 3);

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
    const body = JSON.parse(bodyStr) as AnthropicRequestBody;

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
    return JSON.stringify(body);
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
            } catch {
                // Send without billing header if injection fails
            }
        }

        return globalThis.fetch(url, { ...init, body, headers });
    }) as typeof fetch;
}
```

**Step 2: Update `ProviderManager.ts` — remove inline billing code, import from shared module**

Remove lines 1 (`import { createHash }`) and 24-79 (BILLING_SALT through injectBillingHeader). Replace with imports from new module. Update `detectAnthropicSubscription` to use `SUBSCRIPTION_BETAS`, `SUBSCRIPTION_SYSTEM_PREFIX`, `createSubscriptionFetch()`.

**Step 3: Verify types compile**

Run: `bunx tsgo --noEmit 2>&1 | grep "error TS"`
Expected: no errors

**Step 4: Test subscription auth still works**

Run: `tools claude summarize "d4899002" --provider anthropic --model claude-haiku-4-5 2>&1 | head -5`
Expected: starts streaming summary (not an error)

**Step 5: Commit**

```bash
git add src/utils/claude/subscription-billing.ts src/ask/providers/ProviderManager.ts
git commit -m "refactor: extract subscription OAuth billing header to shared utility"
```

---

### Task 2: DRY system prompt prefix in ask and summarize

**Files:**
- Modify: `src/ask/index.ts:623-638`
- Modify: `src/claude/lib/history/summarize/engine.ts:190-195`

**Step 1: Update `src/ask/index.ts` to use `applySystemPromptPrefix`**

Replace inline prefix logic in `createChatConfig()` with:
```typescript
import { applySystemPromptPrefix } from "@app/utils/claude/subscription-billing";
// ...
const systemPrompt = applySystemPromptPrefix(
    modelChoice.provider.systemPromptPrefix,
    createSystemPrompt(argv.systemPrompt) ?? ""
);
```

**Step 2: Update `src/claude/lib/history/summarize/engine.ts` to use `applySystemPromptPrefix`**

Replace inline prefix logic in `callLLM()` with:
```typescript
import { applySystemPromptPrefix } from "@app/utils/claude/subscription-billing";
// ...
const effectiveSystem = applySystemPromptPrefix(
    providerChoice.provider.systemPromptPrefix,
    systemPrompt
);
```

**Step 3: Verify types compile**

Run: `bunx tsgo --noEmit 2>&1 | grep "error TS"`

**Step 4: Commit**

```bash
git add src/ask/index.ts src/claude/lib/history/summarize/engine.ts
git commit -m "refactor: DRY system prompt prefix via applySystemPromptPrefix"
```

---

### Task 3: Skip subscription detection for explicit non-anthropic provider

**Files:**
- Modify: `src/ask/providers/ProviderManager.ts`

**Step 1: Add optional `targetProvider` param to `detectProviders()`**

```typescript
async detectProviders(targetProvider?: string): Promise<DetectedProvider[]> {
```

At the call site (line 145), skip subscription detection if user explicitly targets a non-anthropic provider:
```typescript
if (!this.detectedProviders.has("anthropic") && (!targetProvider || targetProvider === "anthropic")) {
    await this.detectAnthropicSubscription(askConfig, detected);
}
```

**Step 2: Thread `targetProvider` from ModelSelector**

In `ModelSelector.selectModelByName()`, pass the provider name through to `detectProviders()`.

**Step 3: Verify types compile and test**

Run: `bunx tsgo --noEmit`

**Step 4: Commit**

```bash
git add src/ask/providers/ProviderManager.ts src/ask/providers/ModelSelector.ts
git commit -m "perf: skip subscription detection when targeting non-anthropic provider"
```

---

### Task 4: Move `pickAppleNotesFolder` to `src/utils/prompts/clack/`

**Files:**
- Create: `src/utils/prompts/clack/apple-notes.ts`
- Modify: `src/claude/commands/summarize.ts` (remove function, add import)
- Modify: `src/utils/prompts/clack/index.ts` (re-export)

**Step 1: Extract `pickAppleNotesFolder` (lines 166-201 of summarize.ts)**

Move to `src/utils/prompts/clack/apple-notes.ts`. Import `@clack/prompts` and `@app/utils/macos/apple-notes`.

**Step 2: Update summarize.ts import**

```typescript
import { pickAppleNotesFolder } from "@app/utils/prompts/clack/apple-notes";
```

**Step 3: Export from clack index**

Add to `src/utils/prompts/clack/index.ts`:
```typescript
export { pickAppleNotesFolder } from "./apple-notes";
```

**Step 4: Verify and commit**

```bash
bunx tsgo --noEmit
git add src/utils/prompts/clack/apple-notes.ts src/claude/commands/summarize.ts src/utils/prompts/clack/index.ts
git commit -m "refactor: move pickAppleNotesFolder to utils/prompts/clack"
```

---

### Task 5: Move session helpers out of ClaudeSessionFormatter/Tailer

**Files:**
- Create: `src/utils/claude/session-helpers.ts`
- Modify: `src/utils/claude/ClaudeSessionFormatter.ts` (remove functions, import)
- Modify: `src/utils/claude/ClaudeSessionTailer.ts` (remove function, import)
- Modify: `src/utils/claude/index.ts` (re-export)

**Step 1: Create `session-helpers.ts` with extracted functions**

Extract from ClaudeSessionFormatter.ts:
- `extractToolInputSummary(input)` (line 64)
- `extractToolResultText(block)` (line 91)

Extract from ClaudeSessionTailer.ts:
- `isAssistantEndTurn(msg)` (line 13)

**Step 2: Remove `stripAnsi` duplicate from ClaudeSessionFormatter**

ClaudeSessionFormatter.ts line 40 has a duplicate `stripAnsi()`. Import from `@app/utils/string` instead.

**Step 3: Consolidate `truncate` with existing `truncateText`**

ClaudeSessionFormatter.ts line 52 has `truncate(text, max)` which is nearly identical to `truncateText(text, maxLength)` in `src/utils/string.ts:46`. Replace all `truncate()` calls with `truncateText()` from string utils.

**Step 4: Update imports in both files**

**Step 5: Verify and commit**

```bash
bunx tsgo --noEmit
git add src/utils/claude/session-helpers.ts src/utils/claude/ClaudeSessionFormatter.ts \
  src/utils/claude/ClaudeSessionTailer.ts src/utils/claude/index.ts
git commit -m "refactor: extract session helpers, remove stripAnsi/truncate duplicates"
```

---

### Task 6: Fix `claude tail` user message truncation

**Files:**
- Modify: `src/utils/claude/ClaudeSessionFormatter.ts`

**Step 1: Identify the truncation**

Line 295 in `formatUserMessage()`:
```typescript
const firstLine = text.trim().split("\n")[0];
```

This extracts only the first line of multi-line user messages.

**Step 2: Fix — show full message content (respect existing truncation budget)**

Replace the first-line extraction with the full text, applying the same `truncateText()` limit as tool outputs. The user explicitly wants no stripping of their messages.

```typescript
// Before: const firstLine = text.trim().split("\n")[0];
// After: show full text, only truncate by token budget
const displayText = truncateText(text.trim(), includeSpec.userMessageMaxChars ?? 50_000);
```

Check if `includeSpec` has a user message budget field. If not, add a sensible default (50K chars).

**Step 3: Verify with `tools claude tail`**

Run: `tools claude tail --help` to confirm the tool works.

**Step 4: Commit**

```bash
git add src/utils/claude/ClaudeSessionFormatter.ts
git commit -m "fix(claude tail): show full user messages instead of first-line only"
```

---

### Task 7: Rich colorful output for `claude tail`

**Files:**
- Create: `src/utils/claude/terminal-markdown.ts` (thin wrapper around `marked` + `cli-highlight`)
- Modify: `src/utils/claude/ClaudeSessionFormatter.ts`

**Available packages:** `marked` (installed), `cli-highlight` (installed), `chalk` (installed), `picocolors` (installed)

**Goal:** Make `claude tail` output visually rich:

| Element | Current | Target |
|---------|---------|--------|
| User messages | `You: first line only` | Full message, markdown-rendered |
| Assistant text | Blue first line + dim continuation | Markdown-rendered (code blocks highlighted) |
| Thinking | `💭 first line` dim | Italic dim, full first paragraph |
| Tool use | `[Read] /path...` dim | `[Read]` colored by tool type, path not truncated mid-word |
| Tool output | `→ content` dim | Code output syntax-highlighted when detectable |
| Tool errors | `✗ error` red | Red with error type highlighted |
| Agent sections | Colored border | Keep, add agent name bold |

**Step 1: Create `src/utils/claude/terminal-markdown.ts`**

Thin wrapper using `marked` with a custom terminal renderer:
```typescript
import { marked } from "marked";
import { highlight } from "cli-highlight";
import chalk from "chalk";

export function renderMarkdown(text: string): string { ... }
export function highlightCode(code: string, lang?: string): string { ... }
```

Keep it minimal — just two exports. The `renderMarkdown` function handles:
- Code blocks → syntax highlighted via `cli-highlight`
- Inline code → chalk dim
- Bold/italic → chalk bold/italic
- Headers → chalk bold
- Everything else → passthrough

**Step 2: Update `formatUserMessage()` — show full content, markdown-rendered**

```typescript
// Before: shows only firstLine
// After: render full message through markdown
const rendered = this.options.colors ? renderMarkdown(text.trim()) : text.trim();
this.writeLine(`${pc.dim(time)} ${pc.bold(pc.green("You:"))} ${rendered.split("\n")[0]}`);
for (const line of rendered.split("\n").slice(1)) {
    if (line.trim()) {
        this.writeLine(`         ${line}`);
    }
}
```

**Step 3: Update `formatAssistantMessage()` — markdown-render text blocks**

Apply `renderMarkdown()` to assistant text blocks so code snippets get syntax highlighting.

**Step 4: Update tool output formatting — smarter truncation**

For `[Read]` and similar tools, don't truncate file paths mid-word. Use path-aware truncation:
```typescript
// Before: truncate(path, 80) → "/Users/Martin/Tresors/Projects/GenesisTools/src/ut..."
// After: truncatePath(path, 80) → "...Projects/GenesisTools/src/utils/claude/ClaudeSessionFormatter.ts"
```

Add `truncatePath()` to `src/utils/string.ts` — truncates from the LEFT, keeping the meaningful end of the path.

**Step 5: Verify and commit**

```bash
bunx tsgo --noEmit
tools claude tail --help
git add src/utils/claude/terminal-markdown.ts src/utils/claude/ClaudeSessionFormatter.ts src/utils/string.ts
git commit -m "feat(claude tail): rich colorful output with markdown rendering and syntax highlighting"
```

---

### Task 8: Run /simplify on all touched files

**Files:** All files modified in Tasks 1-6

**Step 1: Run the three review agents in parallel**

Launch code-reuse, code-quality, and efficiency review agents on the full diff of all changes.

**Step 2: Fix any issues found**

**Step 3: Final commit**

```bash
git add -A
git commit -m "chore: simplify and clean up refactored files"
```

---

### Task 9 (Optional): Rename `ModelManager.ts`

**Pushback:** `ModelManager` manages HuggingFace model downloads and cache — it's a lifecycle manager, not a provider. "LocalModelProvider" is misleading. **Skip unless user insists.**

If proceeding:
- Rename: `src/utils/ai/ModelManager.ts` → `src/utils/ai/HFModelManager.ts`
- Update all imports (grep for `ModelManager`)

---

## Dependency Order

```
Task 1 (billing extraction) → Task 2 (DRY prefix) → Task 3 (skip detection)
Task 4 (pickAppleNotesFolder) — independent
Task 5 (session helpers) — independent
Task 6 (tail truncation fix) — depends on Task 5 (uses shared truncateText)
Task 7 (rich tail output) — depends on Task 5+6 (same file, builds on fixes)
Task 8 (simplify) — after all others
Task 9 (optional ModelManager rename) — independent
```

Tasks 1-3 are sequential. Tasks 4, 5 can run in parallel with 1-3. Tasks 6→7 sequential (same file). Task 8 last.
