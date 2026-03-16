# AskUI Logger + JSONL Format Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Centralize all scattered UI logging in the ask tool into a single `AskUILogger` class, and add JSONL output format support.

**Architecture:** A singleton `AskUILogger` class with derived visibility booleans (`suppressUI`, `showDiscovery`, `showProgress`) computed once from config. Each log method checks the relevant boolean and outputs via clack/picocolors. The class is initialized early in the ask tool's entry point. JSONL is added as a new output format alongside JSON.

**Tech Stack:** TypeScript, @clack/prompts, picocolors, Bun

---

### Task 1: Create AskUILogger class

**Files:**
- Create: `src/ask/output/AskUILogger.ts`

**Note:** This file was already created in this session. It needs to be verified and adjusted if needed. The file already contains the full implementation with all methods, visibility matrix, and singleton pattern.

**Step 1: Verify the created file compiles**

Run: `bunx tsgo --noEmit 2>&1 | grep -i "AskUILogger" || echo "No errors"`
Expected: No errors related to AskUILogger

**Step 2: Commit**

```bash
git add src/ask/output/AskUILogger.ts
git commit -m "feat(ask): add centralized AskUILogger class

Singleton class with named methods (logDetected, logThinking, logUsing, etc.)
that centralizes UI visibility decisions based on TTY state, model pre-selection,
raw mode, silent mode, and structured output format."
```

---

### Task 2: Wire AskUILogger into index.ts

**Files:**
- Modify: `src/ask/index.ts`

**Step 1: Add import and initialization**

After line 42 (`import { colorizeProvider, generateSessionId } from "@ask/utils/helpers";`), add:
```typescript
import { askUI, initAskUI } from "@ask/output/AskUILogger";
```

In the `main()` method, after fuzzy model resolution (~line 109, after `fuzzyResolved = true`), add:
```typescript
initAskUI({
    isTTY: process.stdout.isTTY ?? false,
    modelPreSelected: !!argv.model,
    raw: !!argv.raw,
    silent: !!argv.silent,
    showCost: (process.stdout.isTTY ?? false) || !!argv.cost,
    outputFormat: argv.format || argv.output,
});
```

**Step 2: Replace scattered UI calls in `handleSingleMessage()`**

Replace lines 307-311 (the `tty` variable + Using log):
```typescript
// BEFORE:
const tty = process.stdout.isTTY ?? false;
if (tty) {
    p.log.info(`Using ${colorizeProvider(config.provider)}/${config.model}`);
}
// AFTER:
askUI().logUsing({ provider: config.provider, model: config.model });
```

Replace lines 327-329 (Thinking log):
```typescript
// BEFORE:
if (tty) {
    p.log.step(pc.yellow("Thinking..."));
}
// AFTER:
askUI().logThinking();
```

Replace line 365 (cost visibility):
```typescript
// BEFORE:
const showCost = (process.stdout.isTTY ?? false) || argv.cost;
// AFTER:
const showCost = askUI().shouldShowCost();
```

**Step 3: Replace scattered UI calls in `startInteractiveChat()`**

Replace lines 397-398 (intro):
```typescript
// BEFORE:
if (process.stdout.isTTY) {
    p.intro(pc.bgCyan(pc.black(" ASK ")));
}
// AFTER:
askUI().intro();
```

Replace line 410 (Starting with):
```typescript
// BEFORE:
p.log.step(`Starting with ${colorizeProvider(modelChoice.provider.name)}/${modelChoice.model.name}`);
// AFTER:
askUI().logStarting({ provider: modelChoice.provider.name, model: modelChoice.model.name });
```

Replace line 494 (Response time):
```typescript
// BEFORE:
console.log(pc.dim(`\nResponse time: ${formatElapsedTime(duration)}`));
// AFTER:
askUI().logResponseTime({ duration: formatElapsedTime(duration) });
```

Replace lines 551-553 (Session summary):
```typescript
// BEFORE:
p.log.info(pc.dim(`Session saved: ${sessionId}`));
p.log.info(pc.dim(`Messages: ${session.messages.length}`));
p.log.info(pc.dim(`Duration: ${formatElapsedTime(Date.now() - new Date(session.startTime).getTime())}`));
// AFTER:
askUI().logSessionSummary({
    id: sessionId,
    messages: session.messages.length,
    duration: formatElapsedTime(Date.now() - new Date(session.startTime).getTime()),
});
```

Replace lines 555-559 (outro):
```typescript
// BEFORE:
if (process.stdout.isTTY) {
    p.outro(pc.green("Goodbye!"));
} else {
    console.log("Goodbye!");
}
// AFTER:
askUI().outro();
```

**Step 4: Clean up imports**

Remove `colorizeProvider` from line 42 import if no other usage remains in the file (check first — it may still be used elsewhere).
Remove `pc` import if no other direct usage remains (it's still used for `pc.yellow("\nAssistant:")`, `pc.cyan("You:")`, `pc.red(...)` errors, etc. — so keep it).

**Step 5: Run type check**

Run: `bunx tsgo --noEmit 2>&1 | grep "src/ask/index" || echo "No errors"`
Expected: No errors

**Step 6: Commit**

```bash
git add src/ask/index.ts
git commit -m "refactor(ask): wire AskUILogger into index.ts

Replace scattered process.stdout.isTTY guards and p.log.* calls
with centralized askUI().logUsing(), logThinking(), shouldShowCost(), etc."
```

---

### Task 3: Wire AskUILogger into ProviderManager

**Files:**
- Modify: `src/ask/providers/ProviderManager.ts:60-90` (env key detection)
- Modify: `src/ask/providers/ProviderManager.ts:140-160` (subscription detection)

**Step 1: Add import**

Add at top of file:
```typescript
import { askUI } from "@ask/output/AskUILogger";
```

**Step 2: Replace detection logs**

Replace lines 74-76:
```typescript
// BEFORE:
if (process.stdout.isTTY) {
    p.log.step(pc.dim(`Detected ${pc.cyan(config.name)} provider with ${models.length} models`));
}
// AFTER:
askUI().logDetected({ provider: config.name, count: models.length });
```

Replace lines 155-157:
```typescript
// BEFORE:
if (process.stdout.isTTY) {
    p.log.step(pc.dim(`Detected ${pc.cyan("anthropic")}${pc.dim(hint)} provider via subscription`));
}
// AFTER:
askUI().logDetectedSubscription({ provider: "anthropic", hint });
```

**Step 3: Clean up imports**

Remove `import * as p from "@clack/prompts"` and `import pc from "picocolors"` if no other usage in the file.

Check with: `grep -n "p\.\|pc\." src/ask/providers/ProviderManager.ts` — if only the two replaced lines used them, remove the imports.

**Step 4: Run type check**

Run: `bunx tsgo --noEmit 2>&1 | grep "ProviderManager" || echo "No errors"`

**Step 5: Commit**

```bash
git add src/ask/providers/ProviderManager.ts
git commit -m "refactor(ask): use AskUILogger for provider detection logs"
```

---

### Task 4: Wire AskUILogger into LiteLLMPricingFetcher

**Files:**
- Modify: `src/ask/providers/LiteLLMPricingFetcher.ts:422-434`

**Step 1: Add import**

```typescript
import { askUI } from "@ask/output/AskUILogger";
```

**Step 2: Replace info callback**

Replace the `info` callback in the singleton (lines 424-434):
```typescript
// BEFORE:
info: (msg: unknown) => {
    if (!process.stdout.isTTY) {
        return;
    }
    const text = typeof msg === "object" && msg !== null && "msg" in (msg as Record<string, unknown>)
        ? String((msg as Record<string, unknown>).msg)
        : String(msg);
    p.log.step(pc.dim(text));
},
// AFTER:
info: (msg: unknown) => {
    const text = typeof msg === "object" && msg !== null && "msg" in (msg as Record<string, unknown>)
        ? String((msg as Record<string, unknown>).msg)
        : String(msg);
    askUI().logFetching({ source: text });
},
```

**Step 3: Clean up imports**

Remove `import * as p from "@clack/prompts"` and `import pc from "picocolors"` if no other usage. Check the file — `pc` is NOT used elsewhere (all other logging goes through the `logger` parameter). `p` is NOT used elsewhere either.

**Step 4: Run type check**

Run: `bunx tsgo --noEmit 2>&1 | grep "LiteLLMPricing" || echo "No errors"`

**Step 5: Commit**

```bash
git add src/ask/providers/LiteLLMPricingFetcher.ts
git commit -m "refactor(ask): use AskUILogger for pricing fetch logs"
```

---

### Task 5: Add JSONL output format

**Files:**
- Modify: `src/ask/types/chat.ts:84`
- Modify: `src/ask/output/OutputManager.ts:49-84,96-104`
- Modify: `src/ask/utils/cli.ts:13,183,276`

**Step 1: Add "jsonl" to OutputFormat union**

In `src/ask/types/chat.ts:84`:
```typescript
// BEFORE:
export type OutputFormat = "text" | "json" | "markdown" | "clipboard" | "file";
// AFTER:
export type OutputFormat = "text" | "json" | "jsonl" | "markdown" | "clipboard" | "file";
```

**Step 2: Add JSONL handler in OutputManager**

In `src/ask/output/OutputManager.ts`, add case in `handleOutput` switch after the `json` case:
```typescript
case "jsonl":
    await this.outputJSONL(content, metadata);
    break;
```

Add new private method after `outputJSON`:
```typescript
private async outputJSONL(content: string, metadata?: ResponseMetadata): Promise<void> {
    const line = SafeJSON.stringify({
        content,
        timestamp: new Date().toISOString(),
        ...(metadata && { metadata }),
    });
    console.log(line);
}
```

**Step 3: Update CLI validation and help**

In `src/ask/utils/cli.ts`:

Line 13 format option description:
```typescript
// BEFORE:
.option("-f, --format <fmt>", "Output format (text/json/markdown/clipboard/file) or models format (table/json)")
// AFTER:
.option("-f, --format <fmt>", "Output format (text/json/jsonl/markdown/clipboard/file) or models format (table/json)")
```

Line 183 validFormats array:
```typescript
// BEFORE:
const validFormats = ["text", "json", "markdown", "clipboard"];
// AFTER:
const validFormats = ["text", "json", "jsonl", "markdown", "clipboard"];
```

Line 276 validOutputFormats array:
```typescript
// BEFORE:
const validOutputFormats = ["text", "json", "markdown", "clipboard", "file"];
// AFTER:
const validOutputFormats = ["text", "json", "jsonl", "markdown", "clipboard", "file"];
```

Also update help text in `showHelp()` (~line 82-83) to mention jsonl.

**Step 4: Run type check**

Run: `bunx tsgo --noEmit 2>&1 | grep -E "chat\.ts|OutputManager|cli\.ts" || echo "No errors"`

**Step 5: Commit**

```bash
git add src/ask/types/chat.ts src/ask/output/OutputManager.ts src/ask/utils/cli.ts
git commit -m "feat(ask): add JSONL output format

Outputs a single compact JSON line per response, suitable for piping
into jq, log aggregators, or downstream processing."
```

---

### Task 6: Verify end-to-end

**Step 1: Full type check**

Run: `bunx tsgo --noEmit`
Expected: Clean, no errors

**Step 2: Manual test — piped output clean (no UI noise)**

Run: `echo "hello" | bun run src/ask/index.ts -p anthropic -m claude-sonnet-4-20250514`
Expected: Only the response text + newline, no "Detected...", "Using...", "Thinking..."

**Step 3: Manual test — TTY shows UI chrome**

Run: `bun run src/ask/index.ts "hello"`
Expected: Shows Detected providers, Using provider/model, Thinking..., cost breakdown

**Step 4: Manual test — JSONL format**

Run: `echo "hello" | bun run src/ask/index.ts -p anthropic -m claude-sonnet-4-20250514 --format jsonl`
Expected: Single compact JSON line with `{"content":"...","timestamp":"..."}`

**Step 5: Manual test — cost flag in pipe**

Run: `echo "hello" | bun run src/ask/index.ts -p anthropic -m claude-sonnet-4-20250514 --cost`
Expected: Response + cost breakdown shown

**Step 6: Manual test — model pre-selected suppresses discovery**

Run: `echo "hello" | bun run src/ask/index.ts -p anthropic -m claude-sonnet-4-20250514`
vs: `bun run src/ask/index.ts "hello"` (TTY, no model pre-selected)
Expected: First shows no detection logs, second shows them
