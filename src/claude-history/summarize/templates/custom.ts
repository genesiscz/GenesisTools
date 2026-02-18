/**
 * Custom Template
 *
 * Minimal framing with maximum flexibility for user-provided instructions.
 * Wraps session content with the user's custom prompt.
 */

import { buildMetadataBlock, type PromptTemplate, type TemplateContext } from "./index.ts";

export class CustomTemplate implements PromptTemplate {
    name = "custom";
    description = "Flexible template that uses your own custom instructions to analyze the session";

    systemPrompt = `You are analyzing a Claude Code development session transcript. Follow the user's instructions precisely to produce the requested output.`;

    outputInstructions = `Follow the formatting specified in the custom instructions above. If no specific format was requested, use well-structured markdown with clear headers and organized sections.`;

    buildUserPrompt(ctx: TemplateContext): string {
        const instructions = ctx.customInstructions
            ? ctx.customInstructions
            : "No custom instructions were provided. Please produce a general analysis of this session covering: what was accomplished, key decisions made, files modified, and any notable patterns or issues encountered.";

        return `${buildMetadataBlock(ctx)}

## Session Content

${ctx.sessionContent}

## Your Task

${instructions}

## Output Format

${this.outputInstructions}`;
    }
}

export default CustomTemplate;
