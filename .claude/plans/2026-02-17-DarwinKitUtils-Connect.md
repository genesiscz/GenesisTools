# DarwinKit Utils — Connect Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Wire `src/utils/macos/` darwinkit utilities into two places: (A) `macos mail search` gets semantic re-ranking ON by default (opt-out via `--no-semantic`), and (B) the `automate` engine gains an `nlp.*` step handler.

**Architecture:**
- **Connection A:** After Phase 2 (JXA body search) completes in `search.ts`, run the result set through `rankBySimilarity()` from `@app/utils/macos`. Add a `semanticScore` column to `MailMessage` and to the output table. Graceful degradation: if darwinkit is missing/fails, skip semantic ranking with a warning.
- **Connection B:** A new `nlp.ts` step handler in `src/automate/lib/steps/` registers prefix `nlp` and dispatches to `@app/utils/macos/nlp` functions. Follow the `notify.ts` pattern exactly.

**Tech Stack:** TypeScript, Bun, Commander.js, existing `@app/utils/macos` and `@app/macos/` modules — no new npm deps.

**Prerequisites:** Both of the following must be complete before this plan:
- `src/utils/macos/` — DarwinKit utils (`feat(macos-utils)` commits)
- `src/macos/` — Umbrella macos tool (`feat(macos)` commits)

---

## File Map

```
Modify:
  src/macos/lib/mail/types.ts              ← add semanticScore?: number to MailMessage
  src/macos/lib/mail/format.ts             ← add showSemanticScore option + score column
  src/macos/commands/mail/search.ts        ← add --no-semantic, --max-distance, Phase 3
  src/automate/lib/types.ts                ← add NlpStepParams + NlpAction type
  src/automate/lib/steps/index.ts          ← add import "./nlp"

Create:
  src/automate/lib/steps/nlp.ts            ← nlp step handler
  src/automate/presets/email-sentiment-check.json  ← example preset
```

---

## Task 1: Add `semanticScore` to `MailMessage`

**Files:**
- Modify: `src/macos/lib/mail/types.ts`

**Step 1: Add the field**

In `src/macos/lib/mail/types.ts`, add `semanticScore` to `MailMessage` after `bodyMatchesQuery`:

```typescript
/** Enriched message with optional body + attachment info */
export interface MailMessage {
    rowid: number;
    subject: string;
    senderAddress: string;
    senderName: string;
    dateSent: Date;
    dateReceived: Date;
    mailbox: string;
    account: string;
    read: boolean;
    flagged: boolean;
    size: number;
    attachments: MailAttachment[];
    body?: string;
    bodyMatchesQuery?: boolean;
    /** Cosine distance from query (0 = identical). Set when semantic ranking is active. */
    semanticScore?: number;
    recipients?: MailRecipient[];
}
```

**Step 2: Verify no type errors**

```bash
tsgo --noEmit 2>&1 | grep "macos/lib/mail/types" | head -5
# Expected: no output
```

**Step 3: Commit**

```bash
git add src/macos/lib/mail/types.ts
git commit -m "feat(macos-mail): add semanticScore field to MailMessage"
```

---

## Task 2: Add semantic score column to `formatResultsTable`

**Files:**
- Modify: `src/macos/lib/mail/format.ts`

**Step 1: Update `formatResultsTable` signature and implementation**

Change the `options` parameter to accept `showSemanticScore`:

```typescript
export function formatResultsTable(
    messages: MailMessage[],
    options?: { showBodyMatch?: boolean; showSemanticScore?: boolean }
): string {
    const headers = ["Date", "From", "Subject", "Attachments"];
    if (options?.showBodyMatch) headers.push("Body");
    if (options?.showSemanticScore) headers.push("Relevance");

    const rows = messages.map(msg => {
        const row = [
            formatRelativeTime(msg.dateSent, { compact: true }),
            formatSender(msg),
            msg.subject.slice(0, 60) + (msg.subject.length > 60 ? "..." : ""),
            msg.attachments.length > 0 ? `${msg.attachments.length}` : "",
        ];
        if (options?.showBodyMatch) {
            row.push(msg.bodyMatchesQuery ? chalk.green("yes") : "");
        }
        if (options?.showSemanticScore) {
            row.push(
                msg.semanticScore !== undefined
                    ? chalk.cyan((1 - msg.semanticScore / 2).toFixed(2))  // convert distance to 0–1 similarity
                    : ""
            );
        }
        return row;
    });

    return formatTable(rows, headers, { maxColWidth: 60 });
}
```

> **Note:** Relevance shown as similarity (1 = perfect match, 0 = no match) by converting cosine distance (`score/2` → subtracted from 1). This is more intuitive for users than raw distance.

**Step 2: Verify no type errors**

```bash
tsgo --noEmit 2>&1 | grep "macos/lib/mail/format" | head -5
# Expected: no output
```

**Step 3: Commit**

```bash
git add src/macos/lib/mail/format.ts
git commit -m "feat(macos-mail): add semantic score column to formatResultsTable"
```

---

## Task 3: Add semantic re-ranking to `search.ts`

This is the main change. After Phase 2 (JXA body search), add Phase 3 (darwinkit semantic re-ranking), ON by default.

**Files:**
- Modify: `src/macos/commands/mail/search.ts`

**Step 1: Add import for rankBySimilarity**

At the top of `search.ts`, add:

```typescript
import { rankBySimilarity, closeDarwinKit } from "@app/utils/macos";
```

**Step 2: Add `--no-semantic` and `--max-distance` options to the command**

In the `.command("search <query>")` chain, add after the existing options:

```typescript
.option("--no-semantic", "Disable semantic re-ranking (faster, uses keyword order only)")
.option("--max-distance <n>", "Max semantic distance to include (0–2, default: 1.2)", "1.2")
```

**Step 3: Add the options to the action handler type**

Add to the options object type in the `.action()` callback:

```typescript
semantic?: boolean;      // Commander sets this to false when --no-semantic is passed
maxDistance?: string;
```

**Step 4: Add Phase 3 block after Phase 2**

After the closing `}` of the `if (!searchOpts.withoutBody && rows.length > 0)` block, add:

```typescript
// Phase 3: Semantic re-ranking via darwinkit (default ON, opt out with --no-semantic)
let semanticActive = false;
if (options.semantic !== false && messages.length > 0) {
    spinner.start(`Ranking ${messages.length} results by semantic similarity...`);
    try {
        const maxDist = parseFloat(options.maxDistance ?? "1.2");
        const items = messages.map(m => ({
            ...m,
            text: [m.subject, m.senderName, m.senderAddress].filter(Boolean).join(" "),
        }));
        const ranked = await rankBySimilarity(query, items, {
            maxDistance: maxDist,
            language: "en",
        });
        // Re-order messages array and attach scores
        const reordered: MailMessage[] = ranked.map(r => {
            const msg = r.item as MailMessage;
            msg.semanticScore = r.score;
            return msg;
        });
        // Append any messages that were filtered out (beyond maxDistance)
        const rankedIds = new Set(reordered.map(m => m.rowid));
        for (const msg of messages) {
            if (!rankedIds.has(msg.rowid)) reordered.push(msg);
        }
        messages.length = 0;
        messages.push(...reordered);
        semanticActive = true;
        spinner.stop(`Semantic ranking complete (${ranked.length} relevant results)`);
    } catch (err) {
        spinner.stop(
            `Semantic ranking skipped: ${err instanceof Error ? err.message : String(err)}`
        );
        logger.warn(`Semantic ranking failed, falling back to keyword order: ${err}`);
    } finally {
        closeDarwinKit();
    }
}
```

**Step 5: Update the table output call to pass `showSemanticScore`**

Change:

```typescript
console.log(formatResultsTable(messages, {
    showBodyMatch: !searchOpts.withoutBody,
}));
```

To:

```typescript
console.log(formatResultsTable(messages, {
    showBodyMatch: !searchOpts.withoutBody,
    showSemanticScore: semanticActive,
}));
```

**Step 6: Verify no type errors**

```bash
tsgo --noEmit 2>&1 | grep "macos/commands/mail/search" | head -10
# Expected: no output
```

**Step 7: Test the command manually**

```bash
bun run src/macos/index.ts mail search --help
# Expected: shows --no-semantic and --max-distance options

bun run src/macos/index.ts mail search "invoice" --without-body --no-semantic --limit 5
# Expected: fast SQLite-only results (no darwinkit needed)
```

**Step 8: Commit**

```bash
git add src/macos/commands/mail/search.ts
git commit -m "feat(macos-mail): add semantic re-ranking to mail search (default ON, --no-semantic to opt out)"
```

---

## Task 4: Add `NlpStepParams` to automate types

**Files:**
- Modify: `src/automate/lib/types.ts`

**Step 1: Add the NLP action type and params interface**

At the end of the action types section (after `NotifyAction`), add:

```typescript
export type NlpAction = "sentiment" | "language" | "tag" | "distance" | "embed";
```

At the end of the step params section (after `WhileStepParams`), add:

```typescript
export interface NlpStepParams {
  /** Text to analyze */
  text?: string;
  /** For nlp.distance: second text to compare against */
  text2?: string;
  /** For nlp.tag: which schemes to apply. Default: ["lexicalClass"] */
  schemes?: Array<"lexicalClass" | "nameType" | "lemma" | "sentimentScore" | "language">;
  /** BCP-47 language code. Default: "en" */
  language?: string;
  /** For nlp.embed/nlp.distance: "word" or "sentence". Default: "sentence" */
  type?: "word" | "sentence";
}
```

**Step 2: Verify no type errors**

```bash
tsgo --noEmit 2>&1 | grep "automate/lib/types" | head -5
# Expected: no output
```

**Step 3: Commit**

```bash
git add src/automate/lib/types.ts
git commit -m "feat(automate): add NlpStepParams and NlpAction types"
```

---

## Task 5: Create the `nlp` step handler

**Files:**
- Create: `src/automate/lib/steps/nlp.ts`

Follow the exact same pattern as `notify.ts`.

**Step 1: Write the file**

```typescript
// src/automate/lib/steps/nlp.ts

import { registerStepHandler } from "../registry";
import type { StepContext } from "../registry";
import type { NlpStepParams, PresetStep, StepResult } from "../types";
import { makeResult } from "./helpers";
import {
  analyzeSentiment,
  detectLanguage,
  tagText,
  textDistance,
  embedText,
  closeDarwinKit,
} from "@app/utils/macos";

async function nlpHandler(step: PresetStep, ctx: StepContext): Promise<StepResult> {
  const start = performance.now();
  const params = step.params as unknown as NlpStepParams;
  const subAction = step.action.split(".")[1];

  const text = ctx.interpolate(params.text ?? "");
  const language = params.language ?? "en";

  try {
    switch (subAction) {
      case "sentiment": {
        if (!text) return makeResult("error", null, start, "nlp.sentiment requires params.text");
        const result = await analyzeSentiment(text);
        return makeResult("success", result, start);
      }

      case "language": {
        if (!text) return makeResult("error", null, start, "nlp.language requires params.text");
        const result = await detectLanguage(text);
        return makeResult("success", result, start);
      }

      case "tag": {
        if (!text) return makeResult("error", null, start, "nlp.tag requires params.text");
        const schemes = params.schemes ?? ["lexicalClass"];
        const result = await tagText(text, schemes, language);
        return makeResult("success", result, start);
      }

      case "distance": {
        const text2 = ctx.interpolate(params.text2 ?? "");
        if (!text || !text2) {
          return makeResult("error", null, start, "nlp.distance requires params.text and params.text2");
        }
        const type = params.type ?? "sentence";
        const result = await textDistance(text, text2, language, type);
        return makeResult("success", result, start);
      }

      case "embed": {
        if (!text) return makeResult("error", null, start, "nlp.embed requires params.text");
        const type = params.type ?? "sentence";
        const result = await embedText(text, language, type);
        return makeResult("success", result, start);
      }

      default:
        return makeResult("error", null, start, `Unknown nlp action: ${subAction}. Valid: sentiment, language, tag, distance, embed`);
    }
  } catch (error) {
    return makeResult(
      "error",
      null,
      start,
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    closeDarwinKit();
  }
}

registerStepHandler("nlp", nlpHandler);
```

**Step 2: Verify no type errors**

```bash
tsgo --noEmit 2>&1 | grep "automate/lib/steps/nlp" | head -10
# Expected: no output
```

**Step 3: Commit**

```bash
git add src/automate/lib/steps/nlp.ts
git commit -m "feat(automate): add nlp step handler (sentiment, language, tag, distance, embed)"
```

---

## Task 6: Register the `nlp` handler in the step index

**Files:**
- Modify: `src/automate/lib/steps/index.ts`

**Step 1: Add the import**

Add `import "./nlp";` to the list:

```typescript
/**
 * Import all step handler modules to trigger their registerStepHandler() calls.
 * The engine imports this file once at startup.
 */
import "./http";
import "./file";
import "./git";
import "./transform";
import "./notify";
import "./parallel";
import "./loop";
import "./nlp";
```

**Step 2: Commit**

```bash
git add src/automate/lib/steps/index.ts
git commit -m "feat(automate): register nlp step handler"
```

---

## Task 7: Add example preset

**Files:**
- Create: `src/automate/presets/email-sentiment-check.json`

First, check if the presets directory exists:

```bash
ls src/automate/presets/ 2>/dev/null || mkdir -p src/automate/presets/
```

**Step 1: Write the preset**

```json
{
  "$schema": "https://genesis-tools/automate/preset.schema.json",
  "name": "Email Sentiment Check",
  "description": "Analyze the sentiment and language of a given text (e.g. email subject or body). Demonstrates the nlp.* step handlers.",
  "trigger": { "type": "manual" },
  "vars": {
    "text": {
      "type": "string",
      "description": "The text to analyze",
      "required": true
    }
  },
  "steps": [
    {
      "id": "detect-language",
      "name": "Detect language",
      "action": "nlp.language",
      "params": {
        "text": "{{ vars.text }}"
      },
      "output": "languageResult"
    },
    {
      "id": "analyze-sentiment",
      "name": "Analyze sentiment",
      "action": "nlp.sentiment",
      "params": {
        "text": "{{ vars.text }}"
      },
      "output": "sentimentResult"
    },
    {
      "id": "extract-entities",
      "name": "Tag named entities",
      "action": "nlp.tag",
      "params": {
        "text": "{{ vars.text }}",
        "schemes": ["nameType"]
      },
      "output": "tagResult"
    },
    {
      "id": "report",
      "name": "Log results",
      "action": "log",
      "params": {
        "message": "Language: {{ steps.languageResult.output.language }} ({{ steps.languageResult.output.confidence }})\nSentiment: {{ steps.sentimentResult.output.label }} ({{ steps.sentimentResult.output.score }})\nEntities found: {{ steps.tagResult.output.tokens.length }}"
      }
    }
  ]
}
```

**Step 2: Commit**

```bash
git add src/automate/presets/email-sentiment-check.json
git commit -m "feat(automate): add email-sentiment-check example preset for nlp steps"
```

---

## Task 8: End-to-end verification

**Step 1: Check all TypeScript**

```bash
tsgo --noEmit 2>&1 | grep -E "(macos|automate)" | head -20
# Expected: no output
```

**Step 2: Verify search help shows new flags**

```bash
bun run src/macos/index.ts mail search --help
# Expected output includes:
#   --no-semantic            Disable semantic re-ranking (faster, uses keyword order only)
#   --max-distance <n>       Max semantic distance to include (0–2, default: 1.2)
```

**Step 3: Verify automate has nlp in step registry**

```bash
grep -r "nlp" src/automate/lib/steps/index.ts
# Expected:
# import "./nlp";
```

**Step 4: Verify smoke test passes (requires darwinkit installed)**

```bash
which darwinkit && bun run src/utils/macos/_smoke-test.ts
# If darwinkit not installed: "which darwinkit" exits non-zero, skip
```

**Step 5: Final commit if any cleanup needed**

```bash
git add -A
git commit -m "chore(macos,automate): post-connect verification cleanup"
```

---

## Notes on Graceful Degradation

The semantic ranking in `search.ts` is wrapped in `try/catch`. If `darwinkit` is not installed or the subprocess fails to start, the error is logged as a warning and the original keyword-order results are shown without a semantic score column. The search command always works even without darwinkit — the only degradation is no re-ranking.

To check if darwinkit is installed before searching:
```bash
which darwinkit   # exit 0 = installed, exit 1 = not found
```
