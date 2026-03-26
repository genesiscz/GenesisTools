# Centralize System Prompt Prefix via Shared callLLM

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Extract a shared `callLLM()` utility that applies the subscription system prompt prefix in one place, used by both ChatEngine (ask tool) and SummarizeEngine (claude summarize).

**Architecture:** Create `src/utils/ai/call-llm.ts` with a single `callLLM()` function that wraps `generateText`/`streamText` from the `ai` SDK. It accepts a `ProviderChoice` and applies `systemPromptPrefix` internally. Both `ChatEngine` and `SummarizeEngine` call this instead of the SDK directly. The 5 scattered `applySystemPromptPrefix()` calls in `ask/index.ts` and `summarize/engine.ts` collapse to 0 — the prefix is handled at the call layer.

**Tech Stack:** TypeScript, Bun, `ai` SDK (`generateText`, `streamText`), `@ai-sdk/anthropic`

---

### Current state: 5 call sites → target: 1

| # | File | Line | What | After |
|---|------|------|------|-------|
| 1 | `ask/index.ts` | 365 | One-shot handleSingleMessage | Gone — AIChat → ChatEngine → callLLM |
| 2 | `ask/index.ts` | 636 | Interactive createChatConfig | Gone — ChatEngine → callLLM |
| 3 | `ask/index.ts` | 723 | /model command | Gone — ChatEngine → callLLM |
| 4 | `summarize/engine.ts` | 193 | callLLM | Gone — uses shared callLLM |
| 5 | `summarize/engine.ts` | 490 | prompt-only | Gone — uses shared callLLM |

After: `applySystemPromptPrefix` called in exactly 1 place: `src/utils/ai/call-llm.ts`.

---

### Task 1: Create shared `callLLM` utility

**Files:**
- Create: `src/utils/ai/call-llm.ts`

**Step 1: Create `src/utils/ai/call-llm.ts`**

```typescript
import { applySystemPromptPrefix } from "@app/utils/claude/subscription-billing";
import type { ProviderChoice } from "@ask/types";
import { getLanguageModel } from "@ask/types/provider";
import type { LanguageModelUsage } from "ai";
import { generateText, streamText } from "ai";

export interface CallLLMOptions {
    systemPrompt: string;
    userPrompt: string;
    providerChoice: ProviderChoice;
    streaming?: boolean;
    maxTokens?: number;
    temperature?: number;
    /** Write streaming chunks to this writable (defaults to process.stdout) */
    streamTarget?: NodeJS.WritableStream;
}

export interface CallLLMResult {
    content: string;
    usage?: LanguageModelUsage;
}

/**
 * Unified LLM call that handles:
 * - Model resolution from ProviderChoice
 * - Subscription OAuth system prompt prefix
 * - Streaming vs non-streaming
 * - Usage tracking
 */
export async function callLLM(options: CallLLMOptions): Promise<CallLLMResult> {
    const { systemPrompt, userPrompt, providerChoice, streaming, maxTokens, temperature } = options;
    const model = getLanguageModel(providerChoice.provider.provider, providerChoice.model.id);

    // Single point of prefix application for subscription OAuth
    const effectiveSystem = applySystemPromptPrefix(
        providerChoice.provider.systemPromptPrefix,
        systemPrompt
    );

    if (streaming) {
        const result = await streamText({
            model,
            system: effectiveSystem,
            prompt: userPrompt,
            ...(maxTokens ? { maxTokens } : {}),
            ...(temperature !== undefined ? { temperature } : {}),
        });

        const target = options.streamTarget ?? process.stdout;
        let fullResponse = "";

        for await (const chunk of result.textStream) {
            target.write(chunk);
            fullResponse += chunk;
        }

        target.write("\n");
        const usage = await result.usage;
        return { content: fullResponse, usage };
    }

    const result = await generateText({
        model,
        system: effectiveSystem,
        prompt: userPrompt,
        ...(maxTokens ? { maxTokens } : {}),
        ...(temperature !== undefined ? { temperature } : {}),
    });

    return { content: result.text, usage: result.usage };
}
```

**Step 2: Verify types compile**

Run: `bunx tsgo --noEmit 2>&1 | grep "error TS"`

**Step 3: Commit**

```bash
git add src/utils/ai/call-llm.ts
git commit -m "feat: shared callLLM utility with centralized prefix application"
```

---

### Task 2: Wire SummarizeEngine to use shared callLLM

**Files:**
- Modify: `src/claude/lib/history/summarize/engine.ts`

**Step 1: Read `src/claude/lib/history/summarize/engine.ts` — find the private `callLLM` method and all its call sites**

The engine's `callLLM` method (around line 176) does:
1. Get model from providerChoice
2. Apply systemPromptPrefix
3. Call streamText or generateText
4. Return content + usage

This is exactly what the shared `callLLM` does. Replace the private method body with a delegation.

**Step 2: Replace the private callLLM with shared callLLM**

```typescript
import { callLLM as sharedCallLLM } from "@app/utils/ai/call-llm";

// Replace the entire private callLLM method body:
private async callLLM(opts: {
    systemPrompt: string;
    userPrompt: string;
    providerChoice: ProviderChoice;
    streaming: boolean;
    maxTokens?: number;
}): Promise<LLMCallResult> {
    return sharedCallLLM({
        systemPrompt: opts.systemPrompt,
        userPrompt: opts.userPrompt,
        providerChoice: opts.providerChoice,
        streaming: opts.streaming,
        maxTokens: opts.maxTokens,
    });
}
```

**Step 3: Remove the `applySystemPromptPrefix` import and both call sites in engine.ts**

- Remove import of `applySystemPromptPrefix` (line 11)
- Remove the `effectiveSystem` variable in callLLM (shared version handles it)
- Remove the `effectiveSystemPrompt` logic in the `--prompt-only` block (line 490) — use shared callLLM for prompt-only too, or keep the local prefix for debug output only

For `--prompt-only`: the prefix should still appear in debug output. Keep a lightweight call:
```typescript
// In prompt-only block, for debug display only:
if (this.options.provider || this.options.model) {
    const choice = await this.resolveModel();
    const prefix = choice.provider.systemPromptPrefix;
    if (prefix) {
        systemPrompt = `${prefix}\n\n${systemPrompt}`;
    }
}
```

Or import `applySystemPromptPrefix` just for prompt-only debug display. Either way it's not an LLM call — it's text output.

**Step 4: Verify types compile**

Run: `bunx tsgo --noEmit 2>&1 | grep "error TS"`

**Step 5: Test summarize still works**

Run: `tools claude summarize "d4899002" --provider anthropic --model claude-haiku-4-5 2>&1 | head -5`

**Step 6: Commit**

```bash
git add src/claude/lib/history/summarize/engine.ts
git commit -m "refactor(summarize): use shared callLLM, remove local prefix logic"
```

---

### Task 3: Wire ChatEngine to use shared callLLM

**Files:**
- Modify: `src/ask/chat/ChatEngine.ts`

**Step 1: Read `src/ask/chat/ChatEngine.ts` — understand sendStreamingMessage and sendNonStreamingMessage**

ChatEngine's streaming path (around line 86) calls `streamText` with:
- model, prompt (message), system (systemPrompt), temperature, maxOutputTokens
- onFinish callback for usage/cost

The non-streaming path (around line 234) calls `generateText` similarly.

ChatEngine is more complex than SummarizeEngine — it handles:
- Per-message overrides
- Thinking/reasoning events
- Tool support
- Session history
- Message wrapping

**Step 2: Determine integration approach**

ChatEngine can't fully delegate to `callLLM` because it uses `onFinish`, per-chunk event handling, and tools. BUT the system prompt prefix should still be centralized.

Two options:
- (a) ChatEngine applies prefix to `this.config.systemPrompt` once at construction time using the shared utility
- (b) ChatEngine delegates simple calls to shared `callLLM` but keeps its complex streaming path

Option (a) is simplest — ChatEngine's constructor or init applies prefix once. The `ChatConfig` includes `providerChoice` so ChatEngine can do:

```typescript
import { applySystemPromptPrefix } from "@app/utils/claude/subscription-billing";

// In constructor or when config is set:
if (this.config.providerChoice) {
    this.config.systemPrompt = applySystemPromptPrefix(
        this.config.providerChoice.provider.systemPromptPrefix,
        this.config.systemPrompt ?? ""
    );
}
```

This means `createChatConfig` in `ask/index.ts` no longer needs to apply the prefix — ChatEngine does it.

**Step 3: Add `providerChoice` to ChatConfig interface**

In `src/ask/types/config.ts`:
```typescript
import type { ProviderChoice } from "./chat";

export interface ChatConfig {
    // existing fields...
    providerChoice?: ProviderChoice;
}
```

**Step 4: Update ChatEngine constructor to apply prefix**

**Step 5: Update `createChatConfig` in ask/index.ts to pass providerChoice and remove prefix call**

```typescript
// Before:
const systemPrompt = applySystemPromptPrefix(modelChoice.provider.systemPromptPrefix, this.rawSystemPrompt);
return { model, provider, modelName, streaming, systemPrompt, temperature, maxTokens };

// After:
return { model, provider, modelName, streaming, systemPrompt: this.rawSystemPrompt, temperature, maxTokens, providerChoice: modelChoice };
```

**Step 6: Update handleSingleMessage to pass providerChoice to AIChat**

Remove the `applySystemPromptPrefix` call in the one-shot path. Pass `providerChoice` to AIChat, which passes it to ChatEngine.

**Step 7: Update /model command handler**

The `/model` handler at line 723 currently calls `applySystemPromptPrefix`. Instead, update `ChatEngine.setSystemPrompt` to accept an optional `ProviderChoice` and apply prefix internally.

**Step 8: Verify types compile and test**

Run: `bunx tsgo --noEmit 2>&1 | grep "error TS"`

**Step 9: Commit**

```bash
git add src/ask/chat/ChatEngine.ts src/ask/types/config.ts src/ask/index.ts src/ask/AIChat.ts
git commit -m "refactor(ask): ChatEngine applies prefix from providerChoice, remove caller duplication"
```

---

### Task 4: Remove applySystemPromptPrefix from ask/index.ts entirely

**Files:**
- Modify: `src/ask/index.ts`

**Step 1: Verify no calls to `applySystemPromptPrefix` remain in ask/index.ts**

```bash
rg "applySystemPromptPrefix" src/ask/index.ts
```

Expected: 0 matches (only the import line, which should also be removed).

**Step 2: Remove the import**

**Step 3: Remove `rawSystemPrompt` field if no longer needed**

**Step 4: Verify and commit**

```bash
bunx tsgo --noEmit
git add src/ask/index.ts
git commit -m "chore: remove applySystemPromptPrefix from ask/index.ts — fully centralized"
```

---

### Task 5: Push and verify end-to-end

**Step 1: Push**

```bash
git push
```

**Step 2: Test subscription OAuth (haiku)**

```bash
tools claude summarize "d4899002" --provider anthropic --model claude-haiku-4-5 2>&1 | head -5
```

**Step 3: Test ask tool one-shot**

```bash
echo "say hi" | tools ask --provider anthropic --model claude-haiku-4-5
```

---

## Final state

```
src/utils/ai/call-llm.ts          ← ONE place prefix is applied (for direct LLM calls)
  ├── SummarizeEngine.callLLM()    ← delegates to shared callLLM
  └── (future direct callers)

src/ask/chat/ChatEngine.ts         ← applies prefix from providerChoice in constructor
  ├── ask interactive path         ← createChatConfig passes providerChoice
  ├── ask one-shot path            ← AIChat passes providerChoice
  └── /model switch                ← ChatEngine.setSystemPrompt with providerChoice

src/utils/claude/subscription-billing.ts
  ├── applySystemPromptPrefix()    ← still exported, used by call-llm.ts and ChatEngine
  ├── SUBSCRIPTION_SYSTEM_PREFIX   ← used by ProviderManager
  ├── SUBSCRIPTION_BETAS           ← used by ProviderManager
  └── createSubscriptionFetch()    ← used by ProviderManager
```

## Dependency Order

```
Task 1 (create call-llm.ts) → Task 2 (wire summarize) → Task 3 (wire ChatEngine) → Task 4 (cleanup index.ts) → Task 5 (push/test)
```

All sequential.
