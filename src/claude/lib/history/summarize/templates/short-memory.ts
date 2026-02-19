/**
 * Short Memory Template
 *
 * Concise knowledge distillation for MEMORY.md files.
 * Produces 500-2000 characters of the most critical, reusable knowledge
 * as bullet points under topic headers.
 */

import { buildMetadataBlock, type PromptTemplate, type TemplateContext } from "./index.ts";

export class ShortMemoryTemplate implements PromptTemplate {
    name = "short-memory";
    description = "Concise bullet-point knowledge for MEMORY.md files (500-2000 chars)";

    systemPrompt = `You are a concise knowledge distiller. Your task is to extract only the most critical, reusable knowledge from a development session and express it as compact bullet points.

Guidelines:
- Total output must be 500-2000 characters. No exceptions.
- Each bullet must be self-contained — understandable without any other context.
- Include specific file paths, function names, config values, and commands.
- Only include knowledge that would save someone significant time in the future.
- No verbose explanations. No filler. No introductions or conclusions.
- Use short topic headers to group related bullets.
- Write in present tense, declarative style: "X uses Y" not "We found that X uses Y".
- Omit obvious or well-known information. Only capture what is specific to this codebase or session.
- The output should be ready to paste directly into a MEMORY.md file.`;

    outputInstructions = `Format as markdown bullet points under short topic headers. Keep total output between 500-2000 characters.

Example:

## Component Architecture
- \`SessionCache\` uses SQLite with WAL mode at \`~/.cache/tool/db.sqlite\`
- Metadata version is auto-derived from MD5 of \`lib.ts\` + \`cache.ts\` source

## API Gotchas
- DELETE endpoint is \`/timelog/{id}\` (singular), but POST is \`/timelogs/\` (plural)
- Rate limit is 100 req/min per API key, not per user

## Config
- \`tsconfig.json\` needs \`verbatimModuleSyntax: true\` for Bun compatibility`;

    buildUserPrompt(ctx: TemplateContext): string {
        return `${buildMetadataBlock(ctx)}

## Session Content

${ctx.sessionContent}

## Your Task

Distill this session into the most critical, reusable knowledge bullets. Ruthlessly prioritize — only include information that:
- Would save someone significant debugging or research time
- Documents non-obvious behavior, gotchas, or edge cases
- Captures important architecture decisions or patterns specific to this codebase
- Records specific file paths, commands, or config values that are hard to discover

Do NOT include:
- General programming knowledge
- Play-by-play of what happened in the session
- Information that is obvious from reading the code
- Verbose explanations or rationale (keep it terse)

Target: 500-2000 characters total. Each bullet is a standalone fact.${ctx.customInstructions ? `\n\nAdditional instructions: ${ctx.customInstructions}` : ""}

## Output Format

${this.outputInstructions}`;
    }
}

export default ShortMemoryTemplate;
