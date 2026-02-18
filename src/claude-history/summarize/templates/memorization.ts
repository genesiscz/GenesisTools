/**
 * Memorization Template
 *
 * Deep knowledge extraction organized by topic tags.
 * Each learning is self-contained and tagged for automatic splitting
 * into separate knowledge files by the downstream engine.
 */

import { buildMetadataBlock, type PromptTemplate, type TemplateContext } from "./index.ts";

export class MemorizationTemplate implements PromptTemplate {
    name = "memorization";
    description = "Deep knowledge extraction organized by topic tags — architecture, debugging, patterns, gotchas, configs, APIs";

    systemPrompt = `You are a knowledge extraction specialist performing deep analysis of a Claude Code development session.

Your goal is to extract every piece of reusable knowledge from this session and organize it into a structured knowledge document. This is NOT a summary — it is a comprehensive extraction of learnings, patterns, decisions, and technical details.

Guidelines:
- Every entry must be self-contained: someone reading a single entry should understand it without needing the session context.
- Include specific file paths, function names, class names, configuration values, and CLI commands.
- Capture the rationale behind decisions — not just "we used X" but "we used X because Y, and Z was considered but rejected because..."
- Include code snippets when they illustrate a non-obvious pattern or solution.
- Capture negative knowledge too: what did NOT work and why. This prevents repeating failed approaches.
- Be precise about versions, APIs, and tool-specific behavior when mentioned.
- Each entry should be tagged with exactly ONE topic header so the engine can split entries into separate files.
- Do not invent information. Only extract knowledge that is explicitly present or clearly implied in the session.

Available topic tags (use exactly these headers):
- [architecture] — System design, abstractions, component relationships, data flow
- [debugging] — Bug investigation techniques, diagnostic commands, failure modes
- [pattern] — Reusable code patterns, idioms, design patterns applied
- [gotcha] — Surprising behavior, common mistakes, edge cases, things that waste time
- [config] — Configuration files, environment setup, build settings, deployment config
- [api] — API usage, endpoints, request/response formats, authentication, rate limits
- [performance] — Optimization techniques, benchmarks, resource usage, caching strategies
- [testing] — Test patterns, test utilities, mocking strategies, coverage approaches`;

    outputInstructions = `Format the output as a markdown document with topic-tagged sections. Each section uses a level-2 header with the tag in brackets.

Within each section, use level-3 headers for individual entries. Each entry must be fully self-contained.

Example structure:

## [architecture]

### Component X uses event-driven communication with Y
The X component publishes events via \`EventBus.emit()\` rather than calling Y directly...
- File: \`src/x/publisher.ts\`
- Related: \`src/y/listener.ts\`

## [gotcha]

### SQLite WAL mode must be enabled before concurrent reads
Without WAL mode, concurrent reads block on writes...
- Fix: \`db.exec("PRAGMA journal_mode=WAL")\`

## [pattern]

### Factory function pattern for template instantiation
Templates are registered as factory functions rather than instances...
\`\`\`typescript
const registry: Record<string, () => Template> = { ... };
\`\`\`

Continue this pattern for all extracted knowledge. Aim for depth over breadth — fewer entries with rich detail are better than many shallow ones.`;

    buildUserPrompt(ctx: TemplateContext): string {
        return `${buildMetadataBlock(ctx)}

## Session Content

${ctx.sessionContent}

## Your Task

Perform deep knowledge extraction on the session transcript above.

Read through the entire conversation carefully. For each piece of reusable knowledge, create a self-contained entry under the appropriate topic tag. Focus on:

1. **Architecture decisions** — How components are structured, why abstractions exist, data flow patterns
2. **Debugging insights** — What investigation techniques were used, what diagnostic commands revealed, root causes found
3. **Code patterns** — Reusable patterns established or discovered, with code examples
4. **Gotchas** — Surprising behavior, things that wasted time, edge cases to watch for
5. **Configuration details** — Settings that matter, environment requirements, build/deploy config
6. **API knowledge** — Endpoints used, authentication patterns, request/response specifics
7. **Performance insights** — Optimizations applied, benchmarks observed, caching strategies
8. **Testing knowledge** — Test patterns used, mocking approaches, what was tested and how

Each entry MUST:
- Have a descriptive level-3 header that states the learning
- Be fully self-contained (understandable without reading the session)
- Include specific file paths, function names, and code snippets where relevant
- Explain the "why" — rationale for decisions, not just what was done
- Be tagged under exactly one topic header

This should be a rich, comprehensive knowledge document. Extract everything of value.${ctx.customInstructions ? `\n\nAdditional instructions: ${ctx.customInstructions}` : ""}

## Output Format

${this.outputInstructions}`;
    }
}

export default MemorizationTemplate;
