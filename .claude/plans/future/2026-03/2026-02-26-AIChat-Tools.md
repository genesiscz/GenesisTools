# AIChat Tool Calling & Engine Save/Restore

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Wire `AIChatTool` definitions through to the Vercel AI SDK tool-calling loop, and fix `_getEngine` to properly save/restore state on per-call overrides.

**Architecture:** Convert `AIChatTool` (our interface) → AI SDK `tool()` format, pass to `ChatEngine.sendMessage()`, implement a tool-calling loop that executes tools and feeds results back to the model. For save/restore, use the existing `ChatEngine.getConfig()` to snapshot state before overrides and restore after.

**Tech Stack:** Vercel AI SDK (`ai` package — `tool()`, `generateText`, `streamText`), Zod (tool parameter schemas), Bun test runner

**Branch:** `feat/ai-chat-sdk`

---

## Context for the implementer

### Current state

- `AIChatTool` interface exists in `src/ask/lib/types.ts`:
  ```typescript
  interface AIChatTool {
      description: string;
      parameters: unknown; // ZodSchema or JSON schema object
      execute: (params: Record<string, unknown>) => Promise<unknown>;
  }
  ```
- `AIChat` constructor accepts `options.tools?: Record<string, AIChatTool>` but stores it without using it.
- `ChatEngine.sendMessage()` accepts `tools?: Record<string, unknown>` but both `sendStreamingMessage` and `sendNonStreamingMessage` receive it as `_tools?` (unused).
- The AI SDK's `generateText`/`streamText` accept a `tools` param and return `toolCalls`/`toolResults` in the response.
- `ChatEngine.getConfig()` returns the full `ChatConfig` including `temperature`, `maxTokens`, `systemPrompt` — so save/restore IS possible despite the current TODO comment saying otherwise.

### Key files

| File | Role |
|------|------|
| `src/ask/AIChat.ts` | Main SDK class — `send()`, `_generateEvents()`, `_getEngine()` |
| `src/ask/chat/ChatEngine.ts` | Wraps AI SDK `generateText`/`streamText` (411 lines) |
| `src/ask/lib/types.ts` | `AIChatTool`, `AIChatOptions`, `SendOptions`, `ChatResponse` |
| `src/ask/lib/ChatEvent.ts` | Stream events — has `tool_call` and `tool_result` types |
| `src/ask/lib/__tests__/` | Test directory |

### AI SDK tool format

```typescript
import { tool } from "ai";
import { z } from "zod";

const tools = {
    searchWeb: tool({
        description: "Search the web",
        parameters: z.object({ query: z.string() }),
        execute: async ({ query }) => { /* ... */ },
    }),
};

// Pass to generateText/streamText:
const result = await generateText({ model, prompt, tools, maxSteps: 5 });
// maxSteps enables the tool-calling loop (model calls tool → gets result → continues)
```

---

## Task 1: Fix `_getEngine` save/restore (the easy TODO)

**Files:**
- Modify: `src/ask/AIChat.ts` — `_getEngine()` method (~line 255)

**Step 1:** Read `src/ask/AIChat.ts` and locate `_getEngine`. Note that `ChatEngine.getConfig()` already returns the full config. The current code mutates without restoring.

**Step 2:** Refactor `_getEngine` to return both the engine and a restore function. Change the method signature:

```typescript
private _getEngine(override?: SendOptions["override"]): { engine: ChatEngine; restore: () => void } {
    if (!this._engine) {
        throw new Error("AIChat not initialized");
    }

    if (!override) {
        return { engine: this._engine, restore: () => {} };
    }

    // Snapshot current state
    const savedConfig = this._engine.getConfig();

    if (override.temperature !== undefined) {
        this._engine.setTemperature(override.temperature);
    }

    if (override.maxTokens !== undefined) {
        this._engine.setMaxTokens(override.maxTokens);
    }

    if (override.systemPrompt !== undefined) {
        this._engine.setSystemPrompt(override.systemPrompt);
    }

    return {
        engine: this._engine,
        restore: () => {
            this._engine!.setTemperature(savedConfig.temperature ?? 0.7);
            this._engine!.setMaxTokens(savedConfig.maxTokens ?? 4096);
            if (savedConfig.systemPrompt !== undefined) {
                this._engine!.setSystemPrompt(savedConfig.systemPrompt);
            }
        },
    };
}
```

**Step 3:** Update the TODO comment to remove the "ChatEngine doesn't expose getters" claim.

**Step 4:** Update all call sites of `_getEngine` in `_generateEvents` to use the new return shape:

```typescript
const { engine, restore } = this._getEngine(options?.override);
try {
    // ... use engine ...
} finally {
    restore();
}
```

**Step 5:** Run type check:

```bash
bunx tsgo --noEmit | rg "AIChat"
```

**Step 6:** Commit:

```bash
git add src/ask/AIChat.ts
git commit -m "fix(ask): save/restore engine state on per-call overrides"
```

---

## Task 2: Convert `AIChatTool` → AI SDK `tool()` format

**Files:**
- Create: `src/ask/lib/toolAdapter.ts`
- Test: `src/ask/lib/__tests__/toolAdapter.test.ts`

**Step 1:** Write the failing test:

```typescript
import { describe, it, expect } from "bun:test";
import { convertTools } from "../toolAdapter";
import { z } from "zod";

describe("convertTools", () => {
    it("converts AIChatTool map to AI SDK tool map", () => {
        const tools = convertTools({
            greet: {
                description: "Say hello",
                parameters: z.object({ name: z.string() }),
                execute: async ({ name }) => `Hello ${name}`,
            },
        });

        expect(tools).toBeDefined();
        expect(tools.greet).toBeDefined();
        // AI SDK tools have description and parameters
        expect(typeof tools.greet).toBe("object");
    });

    it("returns undefined for empty/undefined tools", () => {
        expect(convertTools(undefined)).toBeUndefined();
        expect(convertTools({})).toBeUndefined();
    });
});
```

**Step 2:** Run test to verify it fails:

```bash
bun test src/ask/lib/__tests__/toolAdapter.test.ts
```

Expected: FAIL — module not found.

**Step 3:** Implement `toolAdapter.ts`:

```typescript
import type { AIChatTool } from "./types";
import type { CoreTool } from "ai";
import { tool } from "ai";
import { z } from "zod";

/**
 * Convert AIChat tool definitions to AI SDK tool format.
 * Returns undefined if no tools provided (AI SDK treats undefined as "no tools").
 */
export function convertTools(
    tools: Record<string, AIChatTool> | undefined,
): Record<string, CoreTool> | undefined {
    if (!tools || Object.keys(tools).length === 0) {
        return undefined;
    }

    const converted: Record<string, CoreTool> = {};

    for (const [name, def] of Object.entries(tools)) {
        converted[name] = tool({
            description: def.description,
            parameters: def.parameters instanceof z.ZodType
                ? def.parameters
                : z.object({}).passthrough(), // fallback for JSON schema — TODO: use jsonSchemaToZod
            execute: async (params) => {
                return await def.execute(params as Record<string, unknown>);
            },
        });
    }

    return converted;
}
```

**Step 4:** Run test to verify it passes:

```bash
bun test src/ask/lib/__tests__/toolAdapter.test.ts
```

**Step 5:** Commit:

```bash
git add src/ask/lib/toolAdapter.ts src/ask/lib/__tests__/toolAdapter.test.ts
git commit -m "feat(ask): add AIChatTool → AI SDK tool adapter"
```

---

## Task 3: Wire tools through ChatEngine

**Files:**
- Modify: `src/ask/chat/ChatEngine.ts` — `sendStreamingMessage`, `sendNonStreamingMessage`

**Step 1:** Read `ChatEngine.ts`. The `_tools` parameter is accepted but unused in both methods. The AI SDK `streamText`/`generateText` calls need the `tools` param and `maxSteps` for the tool-calling loop.

**Step 2:** In `sendStreamingMessage`, change `_tools` to `tools` and pass it through:

```typescript
private async sendStreamingMessage(
    message: string,
    tools?: Record<string, CoreTool>,  // was: _tools?: Record<string, unknown>
    callbacks?: { ... },
): Promise<ChatResponse> {
    // ...
    const result = await streamText({
        model: this.config.model,
        prompt: message,
        system: this.config.systemPrompt,
        temperature: this.config.temperature,
        ...(this.config.maxTokens && { maxOutputTokens: this.config.maxTokens }),
        ...(tools && { tools, maxSteps: 10 }),
        onFinish: async ({ usage }) => { /* ... unchanged ... */ },
    });
    // ...
```

**Step 3:** Same for `sendNonStreamingMessage`:

```typescript
private async sendNonStreamingMessage(
    message: string,
    tools?: Record<string, CoreTool>,  // was: _tools?: Record<string, unknown>
): Promise<ChatResponse> {
    const result = await generateText({
        model: this.config.model,
        prompt: message,
        system: this.config.systemPrompt,
        temperature: this.config.temperature,
        ...(this.config.maxTokens && { maxOutputTokens: this.config.maxTokens }),
        ...(tools && { tools, maxSteps: 10 }),
    });
```

**Step 4:** Update the `sendMessage` public method signature:

```typescript
import type { CoreTool } from "ai";

async sendMessage(
    message: string,
    tools?: Record<string, CoreTool>,  // was: Record<string, unknown>
    callbacks?: { ... },
): Promise<ChatResponse> {
```

**Step 5:** Run type check:

```bash
bunx tsgo --noEmit | rg "ChatEngine"
```

**Step 6:** Commit:

```bash
git add src/ask/chat/ChatEngine.ts
git commit -m "feat(ask): pass tools to AI SDK streamText/generateText with maxSteps"
```

---

## Task 4: Wire tools from AIChat → ChatEngine

**Files:**
- Modify: `src/ask/AIChat.ts` — `_generateEvents` method

**Step 1:** Read `AIChat.ts`. In `_generateEvents`, the `engine.sendMessage()` call passes `undefined` for tools. Wire the converted tools through.

**Step 2:** Add import and convert tools in constructor or lazily:

```typescript
import { convertTools } from "./lib/toolAdapter";
```

**Step 3:** In `_generateEvents`, replace the `undefined` tools argument:

```typescript
const aiSdkTools = convertTools(this._options.tools);

const engineResponse = await engine.sendMessage(
    message,
    aiSdkTools,  // was: undefined
    {
        onChunk: (chunk: string) => { ... },
    },
);
```

**Step 4:** Emit `ChatEvent.toolCall` and `ChatEvent.toolResult` events for each tool call in the engine response. After the `controller.enqueue(ChatEvent.done(response))` section, check `engineResponse.toolCalls`:

```typescript
// Emit tool call events from the engine response
if (engineResponse.toolCalls) {
    for (const tc of engineResponse.toolCalls) {
        controller.enqueue(ChatEvent.toolCall(tc.toolCallId, tc.args));
        // Tool results are already handled by AI SDK maxSteps loop
    }
}
```

Note: With `maxSteps`, the AI SDK handles the tool call → execute → feed result → continue loop internally. The `toolCalls` in the response represent what was called. For streaming tool events, we'd need to use `streamText`'s `onToolCall` callback — that's a follow-up enhancement.

**Step 5:** Update `ChatResponse` type to include tool call info from the engine:

In `types.ts`, the `toolCalls` field already exists:
```typescript
toolCalls?: { name: string; input: unknown; output: unknown; duration: number }[];
```

Map the engine's toolCalls to this format in the response construction.

**Step 6:** Run type check:

```bash
bunx tsgo --noEmit | rg "AIChat"
```

**Step 7:** Run all tests:

```bash
bun test src/ask/
```

**Step 8:** Commit:

```bash
git add src/ask/AIChat.ts
git commit -m "feat(ask): wire AIChatTool through to ChatEngine tool-calling loop"
```

---

## Task 5: Add integration test for tool calling

**Files:**
- Create: `src/ask/lib/__tests__/AIChat.tools.test.ts`

**Step 1:** Write a test that verifies the full tool-calling flow. This requires mocking `ChatEngine` since we don't want real API calls:

```typescript
import { describe, it, expect, mock } from "bun:test";
import { z } from "zod";
import { convertTools } from "../toolAdapter";

describe("AIChat tool calling", () => {
    it("converts Zod-based tools to AI SDK format", () => {
        const tools = convertTools({
            getWeather: {
                description: "Get weather for a city",
                parameters: z.object({
                    city: z.string().describe("City name"),
                    unit: z.enum(["celsius", "fahrenheit"]).optional(),
                }),
                execute: async ({ city }) => ({ temp: 22, city, unit: "celsius" }),
            },
        });

        expect(tools).toBeDefined();
        expect(tools!.getWeather).toBeDefined();
    });

    it("executes tool and returns result", async () => {
        let executed = false;
        const tools = convertTools({
            add: {
                description: "Add two numbers",
                parameters: z.object({ a: z.number(), b: z.number() }),
                execute: async ({ a, b }) => {
                    executed = true;
                    return (a as number) + (b as number);
                },
            },
        });

        // Verify the execute function works through the adapter
        const result = await (tools!.add as { execute: (params: unknown) => Promise<unknown> })
            .execute({ a: 2, b: 3 });
        expect(result).toBe(5);
        expect(executed).toBe(true);
    });
});
```

**Step 2:** Run tests:

```bash
bun test src/ask/lib/__tests__/AIChat.tools.test.ts
```

**Step 3:** Commit:

```bash
git add src/ask/lib/__tests__/AIChat.tools.test.ts
git commit -m "test(ask): add tool calling integration tests"
```

---

## Task 6: Update barrel exports

**Files:**
- Modify: `src/ask/index.lib.ts`

**Step 1:** Add `convertTools` to exports:

```typescript
export { convertTools } from "./lib/toolAdapter";
```

**Step 2:** Run type check:

```bash
bunx tsgo --noEmit | rg "index.lib"
```

**Step 3:** Final full test run:

```bash
bun test src/ask/
```

**Step 4:** Commit and push:

```bash
git add src/ask/index.lib.ts
git commit -m "feat(ask): export convertTools from barrel"
git push origin feat/ai-chat-sdk
```

---

## Summary

| Task | What | Priority |
|------|------|----------|
| 1 | Fix `_getEngine` save/restore using `getConfig()` | HIGH — bug fix |
| 2 | `toolAdapter.ts` — convert `AIChatTool` → AI SDK `tool()` | HIGH — core feature |
| 3 | Wire tools through `ChatEngine.sendMessage` | HIGH — core feature |
| 4 | Wire tools from `AIChat._generateEvents` → ChatEngine | HIGH — connects everything |
| 5 | Integration tests for tool calling | MED — verification |
| 6 | Update barrel exports | LOW — cleanup |

## Future enhancements (out of scope)

- **Streaming tool events**: Use `streamText`'s `onToolCall`/`onToolResult` callbacks to emit `ChatEvent.toolCall`/`ChatEvent.toolResult` in real-time during streaming (currently only available after completion).
- **JSON Schema → Zod**: For `AIChatTool.parameters` that are plain JSON Schema objects (not Zod), use a converter like `zod-to-json-schema` in reverse. Current fallback is `z.object({}).passthrough()`.
- **Tool call duration tracking**: Wrap `execute` calls with timing to populate `ChatResponse.toolCalls[].duration`.
- **maxSteps configuration**: Expose `maxSteps` as an `AIChatOptions` or `SendOptions` param instead of hardcoding 10.
