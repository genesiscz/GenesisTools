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
