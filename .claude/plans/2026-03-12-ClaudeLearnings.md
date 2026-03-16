# Plan: `--mode learnings` for `tools claude history summarize`

**Date:** 2026-03-12
**Branch:** `feat/ask-updates`
**Goal:** Add a `learnings` template mode that extracts benchmarks, findings, and actionable insights from Claude Code conversation transcripts into structured tables and lists.

## Architecture

The summarize system uses a template plugin pattern:

1. **Template class** in `src/claude/lib/history/summarize/templates/` implements `PromptTemplate`
2. **Template registry** in `templates/index.ts` maps `TemplateName` -> factory function
3. **SummarizeEngine** in `engine.ts` calls `getTemplate(mode)` and orchestrates the LLM pipeline
4. **CLI** in `src/claude/commands/summarize.ts` passes `--mode` to the engine

Adding a new mode requires:
- One new template file
- One registration in the template index
- Zero changes to the engine or CLI (they already support arbitrary template names)

## Tech Stack

- TypeScript (Bun runtime, no build step)
- Vercel AI SDK (`generateText`/`streamText`) for LLM calls
- `@clack/prompts` for interactive UI
- Existing `PromptTemplate` interface + `buildMetadataBlock` helper

## Reference: Existing Templates

| Template | File | Focus |
|----------|------|-------|
| `documentation` | `documentation.ts` | Narrative session summary |
| `memorization` | `memorization.ts` | Topic-tagged memory notes |
| `short-memory` | `short-memory.ts` | Compact memory notes |
| `changelog` | `changelog.ts` | Added/Changed/Fixed/Removed |
| `debug-postmortem` | `debug-postmortem.ts` | Investigation timeline, dead ends, root cause |
| `onboarding` | `onboarding.ts` | Onboarding-focused summary |
| `custom` | `custom.ts` | User-defined prompt |

## Tasks

### Task 1: Create the Learnings template class

**File:** `src/claude/lib/history/summarize/templates/learnings.ts` (NEW)

Create `LearningsTemplate` implementing `PromptTemplate` with:

- **`name`:** `"learnings"`
- **`description`:** `"Extract benchmarks, findings, and actionable insights into structured tables"`
- **`systemPrompt`:** Instructs the LLM to act as a technical analyst extracting structured data. Key guidelines:
  - Focus on extractable, structured data rather than narrative
  - Produce markdown tables with consistent columns
  - Separate benchmarks/metrics from qualitative findings
  - Only include items actually present in the transcript (no fabrication)
  - Prefer specificity: exact numbers, file paths, command names, error codes
- **`outputInstructions`:** Defines the output format (see below)
- **`buildUserPrompt(ctx)`:** Uses `buildMetadataBlock(ctx)`, includes session content, task description, and output format

**Output format structure:**

```markdown
# Learnings: [Brief session description]

**Date:** [session date]
**Branch:** [branch if available]
**Project:** [project if available]

## Benchmarks & Metrics

| Metric | Value | Context | Notes |
|--------|-------|---------|-------|
| Build time | 2.3s | after tree-shaking | down from 4.1s |
| Bundle size | 142KB | production build | gzipped |
| Test pass rate | 47/47 | unit tests | all green |

(Table of any measurable data points: performance numbers, test results, bundle sizes, timing, counts, etc. Omit this section if no metrics were found.)

## Key Findings

Numbered list of discoveries, insights, and things learned during the session:

1. **[Finding title]** -- Explanation with specific details
2. ...

## Configuration & Environment

Changes to config files, environment variables, tool settings, or dependencies discovered/modified during the session:

- `tsconfig.json`: Set `"moduleResolution": "bundler"` to fix import resolution
- ...

(Omit if none found.)

## Actionable Items

Things to follow up on, TODOs mentioned, warnings to address, or improvements to make:

- [ ] [Action item with specific file/context]
- [ ] ...

(Omit if none found.)

## Gotchas & Pitfalls

Surprising behaviors, footguns, or "watch out for this" moments:

- **[Short label]** -- What happened and why it was surprising
- ...

(Omit if none found.)
```

**Pattern to follow:** Model after `debug-postmortem.ts` -- similar class structure, similar `buildUserPrompt` with task instructions and output format appended.

```typescript
import { buildMetadataBlock, type PromptTemplate, type TemplateContext } from "./index.ts";

export class LearningsTemplate implements PromptTemplate {
    name = "learnings";
    description = "Extract benchmarks, findings, and actionable insights into structured tables";

    systemPrompt = `You are a technical analyst extracting structured learnings from a Claude Code development session transcript.

Your goal is to mine the session for concrete, reusable knowledge: performance numbers, configuration discoveries, surprising behaviors, and actionable next steps. The output should be scannable tables and lists, not prose.

Guidelines:
- Extract every measurable data point into the Benchmarks table (build times, test counts, file sizes, API response times, error rates, token counts, etc.)
- Key Findings should capture "aha moments" and non-obvious discoveries — things a developer would want to remember
- Configuration changes should include the exact setting, file, and value
- Actionable Items should be specific enough to act on without re-reading the session
- Gotchas should document surprising or counterintuitive behavior that could trip someone up again
- Do not fabricate data. Only extract what is explicitly present in the session transcript.
- Omit any section that has no relevant entries rather than leaving it empty.
- Use exact numbers, file paths, command names, and error messages — specificity is the point.`;

    outputInstructions = `Format as structured markdown:

# Learnings: [Brief session description]

**Date:** [session date]
**Branch:** [branch if available]
**Project:** [project if available]

## Benchmarks & Metrics

| Metric | Value | Context | Notes |
|--------|-------|---------|-------|
| [metric name] | [value] | [when/where measured] | [comparison or significance] |

## Key Findings

1. **[Finding title]** — Detailed explanation with specifics
2. ...

## Configuration & Environment

- \`[file/setting]\`: [what was set/changed and why]
- ...

## Actionable Items

- [ ] [Specific action with file/context]
- ...

## Gotchas & Pitfalls

- **[Short label]** — What happened, why it was surprising, and how to avoid it
- ...

Omit any section that has zero entries.`;

    buildUserPrompt(ctx: TemplateContext): string {
        return `${buildMetadataBlock(ctx)}

## Session Content

${ctx.sessionContent}

## Your Task

Analyze this session transcript and extract structured learnings. Think of yourself as mining a conversation for reusable knowledge.

Carefully scan for:
1. **Benchmarks & Metrics** — Any numbers: build times, test results, file sizes, API timings, token counts, memory usage, request counts. Include the context (what was being measured, before/after comparisons).
2. **Key Findings** — Non-obvious discoveries, insights, or "TIL" moments. Things that would save time if known in advance.
3. **Configuration & Environment** — Settings changed, environment variables set, dependencies added/removed, tool configurations adjusted.
4. **Actionable Items** — TODOs mentioned, warnings to address, follow-up tasks, tech debt noted, improvements suggested but not yet implemented.
5. **Gotchas & Pitfalls** — Surprising behaviors, misleading error messages, API quirks, footguns, things that "should work but don't."

For the Benchmarks table, always include:
- The metric name (be specific: "cold start time" not just "time")
- The exact value with units
- Context (what was being measured, which tool/command)
- Notes (comparison to previous value, whether this is good/bad, significance)

Prefer structured data over narrative. The goal is a reference document someone can scan quickly.${ctx.customInstructions ? `\n\nAdditional instructions: ${ctx.customInstructions}` : ""}

## Output Format

${this.outputInstructions}`;
    }
}

export default LearningsTemplate;
```

**Commit point:** "feat(claude): add learnings template for history summarize"

---

### Task 2: Register the template in the template index

**File:** `src/claude/lib/history/summarize/templates/index.ts`

**Changes:**

1. Add import at top:
   ```typescript
   import { LearningsTemplate } from "./learnings.ts";
   ```

2. Add `"learnings"` to the `TemplateName` union type:
   ```typescript
   export type TemplateName =
       | "documentation"
       | "memorization"
       | "short-memory"
       | "changelog"
       | "debug-postmortem"
       | "onboarding"
       | "learnings"
       | "custom";
   ```

3. Add entry to `templateRegistry`:
   ```typescript
   learnings: () => new LearningsTemplate(),
   ```

That's it. No changes needed in `engine.ts`, `summarize.ts`, or `history.ts` -- the existing code already handles arbitrary template names via the registry.

**Commit point:** "feat(claude): register learnings template in summarize system"

---

### Task 3: Verify with type checking

Run `tsgo --noEmit` to confirm no type errors were introduced. The `TemplateName` union change propagates through `getTemplate()` and `listTemplates()` automatically.

```bash
tsgo --noEmit | rg "summarize/templates"
```

**Commit point:** (amend previous if clean, or standalone fix commit if issues found)

---

## Summary

| # | Task | File(s) | Type |
|---|------|---------|------|
| 1 | Create `LearningsTemplate` class | `src/claude/lib/history/summarize/templates/learnings.ts` (NEW) | New file |
| 2 | Register in template index | `src/claude/lib/history/summarize/templates/index.ts` | Edit (3 changes) |
| 3 | Type check | n/a | Verification |

**Total files changed:** 2 (1 new, 1 edited)
**Estimated effort:** ~15 minutes
**Risk:** Very low -- purely additive, no changes to engine or CLI logic

## Usage After Implementation

```bash
# Interactive
tools claude history summarize -i --mode learnings

# Non-interactive with specific session
tools claude history summarize <session-id> --mode learnings

# With output file
tools claude history summarize <session-id> --mode learnings -o learnings.md

# With clipboard
tools claude history summarize --current --mode learnings --clipboard

# Thorough mode for large sessions
tools claude history summarize <session-id> --mode learnings --thorough
```
