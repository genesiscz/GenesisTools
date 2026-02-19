/**
 * Changelog Template
 *
 * Produces a structured changelog in the style of Keep a Changelog.
 * Organized into Added, Changed, Fixed, and Removed sections
 * with file paths and brief descriptions.
 */

import { buildMetadataBlock, type PromptTemplate, type TemplateContext } from "./index.ts";

export class ChangelogTemplate implements PromptTemplate {
    name = "changelog";
    description = "Structured changelog with Added/Changed/Fixed/Removed sections and file paths";

    systemPrompt = `You are a technical changelog writer analyzing a Claude Code development session.

Your goal is to produce a clear, well-organized changelog that a team member could read to understand what changed, why it changed, and where the changes are located.

Guidelines:
- Write in past tense ("Added", "Fixed", "Changed", "Removed").
- Every entry must include the relevant file path(s) in backtick formatting.
- Include enough context to understand each change without reading the code, but keep entries concise.
- Group related changes into a single entry rather than listing every micro-change.
- If a change spans multiple files, list the primary file first, then mention related files.
- Distinguish between new features (Added), modifications to existing behavior (Changed), bug fixes (Fixed), and deletions/deprecations (Removed).
- If a change is a refactor with no user-visible impact, note that explicitly.
- Order entries within each section by importance, not chronologically.
- Do not fabricate changes. Only document what is explicitly shown in the session transcript.
- If the session includes dependency updates, configuration changes, or tooling changes, include those too.`;

    outputInstructions = `Format as a markdown changelog following the Keep a Changelog convention:

# Changelog — [Brief session description]

**Date:** [session date]
**Branch:** [branch if available]

## Added
New features, files, or capabilities that did not exist before.
- Created \`path/to/file.ts\` — Brief description of what it does and why it was needed

## Changed
Modifications to existing code, behavior, or configuration.
- Updated \`path/to/file.ts\` — What changed and why (e.g., "Switched from polling to WebSocket for real-time updates")

## Fixed
Bug fixes and corrections.
- Fixed \`path/to/file.ts\` — What was broken, what caused it, and how it was fixed

## Removed
Deleted files, removed features, or deprecated functionality.
- Removed \`path/to/old-file.ts\` — Why it was removed and what replaces it (if anything)

Omit any section that has no entries. Each entry should be a single bullet point (may wrap to multiple lines for clarity).`;

    buildUserPrompt(ctx: TemplateContext): string {
        return `${buildMetadataBlock(ctx)}

## Session Content

${ctx.sessionContent}

## Your Task

Analyze the session transcript and produce a structured changelog documenting every meaningful change.

Carefully trace through the session to identify:
1. **New files or features** that were created from scratch (Added)
2. **Modifications** to existing files — what was changed and why (Changed)
3. **Bug fixes** — what was broken, what caused it, and how it was resolved (Fixed)
4. **Deletions** — files removed, features deprecated, dead code cleaned up (Removed)

For each change:
- Include the file path in backticks
- Describe what changed in a single concise sentence
- Add a brief "why" if the reason is not obvious from the description
- If multiple files were affected by a single logical change, group them together

Think like you are writing release notes for your team. Someone should be able to read this changelog and understand the full scope of work without looking at a diff.${ctx.customInstructions ? `\n\nAdditional instructions: ${ctx.customInstructions}` : ""}

## Output Format

${this.outputInstructions}`;
    }
}

export default ChangelogTemplate;
