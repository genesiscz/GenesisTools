/**
 * Onboarding Template
 *
 * Produces beginner-friendly documentation for someone who has never
 * seen this part of the codebase. Focuses on "how things work" rather
 * than "what happened in this session."
 */

import { buildMetadataBlock, type PromptTemplate, type TemplateContext } from "./index.ts";

export class OnboardingTemplate implements PromptTemplate {
    name = "onboarding";
    description =
        "Beginner-friendly codebase documentation with architecture overview, file roles, data flow, and practical recipes";

    systemPrompt = `You are a technical writer creating onboarding documentation from a Claude Code development session transcript.

Your goal is to produce documentation that helps a developer who has NEVER seen this codebase understand how things work. You are extracting architectural knowledge and practical guidance from the session, not summarizing what happened.

Guidelines:
- Write for someone with general programming experience but zero knowledge of this specific codebase.
- Explain concepts from first principles. Do not assume familiarity with project-specific abstractions.
- Use concrete examples throughout. Instead of "the system processes events", show an actual event flow with real class/function names.
- Focus on HOW things work, not what was done during the session. The session is your source material, not the subject of the document.
- When explaining architecture, start with the big picture and zoom in progressively.
- Include practical "how to do X" recipes wherever the session reveals common operations.
- Mention gotchas and non-obvious behavior that a newcomer would stumble on.
- Use diagrams described in text (e.g., "A calls B, which queries C and returns D") when they clarify data flow.
- Reference specific file paths and function names so readers can navigate the code.
- If the session reveals conventions or patterns that are followed in this codebase, document them explicitly.
- Do not fabricate information. Only document what is revealed by the session transcript.`;

    outputInstructions = `Format as an onboarding document:

# [Component/Feature Name] — Developer Guide

## Overview
What this part of the codebase does, in plain language. 2-3 sentences max. A new developer should immediately understand the purpose after reading this.

## Architecture
How the system is organized. Key abstractions, their responsibilities, and how they relate to each other. Include a simplified mental model.

### Key Abstractions
- **[Name]** (\`path/to/file.ts\`) — What it is, what it does, when you would interact with it

## Key Files and Their Roles
A mapping of important files to their purpose:
| File | Purpose |
|------|---------|
| \`src/foo/index.ts\` | Entry point, CLI argument parsing |
| \`src/foo/lib.ts\` | Core logic, exported functions |
| ... | ... |

## Data Flow
How data moves through the system for the most common operations. Use numbered steps:
1. User runs \`command X\`
2. \`index.ts\` parses args and calls \`lib.processInput()\`
3. \`lib.ts\` reads from \`~/.config/tool/\` and...
4. ...

## Common Operations
Practical recipes for tasks a developer would need to do:

### How to [do common task 1]
Step-by-step with commands and file references.

### How to [do common task 2]
...

## Conventions and Patterns
Coding conventions, naming patterns, and architectural patterns followed in this codebase.

## Gotchas and Tips
Non-obvious things that would trip up a newcomer:
- **[Gotcha]** — Explanation and how to handle it
- ...`;

    buildUserPrompt(ctx: TemplateContext): string {
        return `${buildMetadataBlock(ctx)}

## Session Content

${ctx.sessionContent}

## Your Task

Analyze this session transcript and extract onboarding documentation for the part of the codebase that was worked on.

You are writing for a developer who has NEVER seen this code. The session transcript is your source material — mine it for architectural knowledge, but do NOT write about the session itself.

Extract and document:
1. **What this code does** — The purpose and scope of the component/feature worked on
2. **How it is organized** — Key files, their roles, and relationships between components
3. **Key abstractions** — Important classes, interfaces, types, and their responsibilities
4. **Data flow** — How data moves through the system for primary operations
5. **Common operations** — Practical "how to" recipes revealed by the session (e.g., how to add a new X, how to test Y)
6. **Conventions** — Coding patterns, naming conventions, and architectural patterns used
7. **Gotchas** — Non-obvious behavior, common mistakes, and tips for newcomers

Write in clear, approachable language. Use concrete examples from the code. Include file paths so readers can navigate to the source.

Remember: you are writing a guide to the CODE, not a summary of the SESSION.${ctx.customInstructions ? `\n\nAdditional instructions: ${ctx.customInstructions}` : ""}

## Output Format

${this.outputInstructions}`;
    }
}

export default OnboardingTemplate;
