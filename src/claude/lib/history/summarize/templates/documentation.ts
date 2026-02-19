/**
 * Documentation Template
 *
 * Produces thorough technical documentation of a development session.
 * Designed for long-term reference — captures the "why" behind decisions,
 * includes code snippets, and organizes by component/file.
 */

import { buildMetadataBlock, type PromptTemplate, type TemplateContext } from "./index.ts";

export class DocumentationTemplate implements PromptTemplate {
    name = "documentation";
    description = "Thorough technical documentation with code snippets, decision rationale, and file-by-file breakdown";

    systemPrompt = `You are a senior technical documentation writer analyzing a Claude Code development session transcript.

Your goal is to produce comprehensive, well-structured documentation that captures everything a developer would need to fully understand this work months or years later.

Guidelines:
- Be thorough and precise. Include specific file paths, function names, and configuration values.
- When the session contains code changes, include the most important code snippets verbatim — especially patterns that are reusable or non-obvious.
- Focus on the "why" behind each decision, not just what was done. If the developer considered alternatives, document those too.
- If the session involves debugging, clearly separate the investigation process from the final solution.
- Organize changes by file or component, not chronologically. Group related changes together.
- Use markdown formatting with clear headers, code blocks with language tags, and bullet points.
- If the session references external documentation, APIs, or tools, note the specific versions and URLs mentioned.
- Do not invent information that is not present in the session transcript.`;

    outputInstructions = `Format the output as a markdown document with these sections (omit any section that has no relevant content):

# Session Documentation: [Brief descriptive title]

## Problem Statement
What problem was being solved or what feature was being built. Include the initial requirements or bug description.

## Root Cause Analysis
(Include only if the session involved debugging) What was the underlying cause of the issue, and how was it identified.

## Changes Made
Organize by file or component. For each:
- **File path** and what was changed
- **Why** the change was made
- Key code snippets (in fenced code blocks with language tags)
- Any notable decisions or trade-offs

## Key Code Patterns
Reusable patterns discovered, established, or worth noting. Include code examples.

## Architecture Decisions
Any significant design choices made during the session, with rationale.

## Lessons Learned
Insights gained, gotchas encountered, or knowledge that would be valuable for future work.

## Related Files
List of all files that were read, modified, or created during the session, grouped by role (source, config, test, etc.).`;

    buildUserPrompt(ctx: TemplateContext): string {
        return `${buildMetadataBlock(ctx)}

## Session Content

${ctx.sessionContent}

## Your Task

Analyze the entire session transcript above and produce comprehensive technical documentation.

Read through the full conversation carefully. Identify:
1. What problem was being solved or what feature was being built
2. Every file that was modified, created, or examined
3. The reasoning behind each significant decision
4. Any debugging steps, failed approaches, or alternative solutions considered
5. Code patterns that are reusable or illustrate important concepts
6. Configuration changes and their purpose
7. Lessons learned or gotchas discovered

Be thorough. This document should serve as a complete reference for someone who needs to understand, maintain, or extend this work in the future.${ctx.customInstructions ? `\n\nAdditional instructions: ${ctx.customInstructions}` : ""}

## Output Format

${this.outputInstructions}`;
    }
}

export default DocumentationTemplate;
