/**
 * Prompt Template System for Claude History Summarization
 *
 * Provides structured prompt templates for different summarization modes.
 * Each template defines a system prompt, user prompt builder, and output format
 * instructions optimized for specific use cases.
 */

import { ChangelogTemplate } from "./changelog.ts";
import { CustomTemplate } from "./custom.ts";
import { DebugPostmortemTemplate } from "./debug-postmortem.ts";
import { DocumentationTemplate } from "./documentation.ts";
import { MemorizationTemplate } from "./memorization.ts";
import { OnboardingTemplate } from "./onboarding.ts";
import { ShortMemoryTemplate } from "./short-memory.ts";

// =============================================================================
// Interfaces & Types
// =============================================================================

export interface PromptTemplate {
    /** Template identifier */
    name: string;
    /** Human-readable description */
    description: string;
    /** System prompt for the LLM */
    systemPrompt: string;
    /** Build the user prompt with session context */
    buildUserPrompt(context: TemplateContext): string;
    /** Output format instructions (included at end of user prompt) */
    outputInstructions: string;
}

export interface TemplateContext {
    sessionContent: string;
    sessionId: string;
    sessionDate: string;
    gitBranch?: string;
    projectName?: string;
    sessionTitle?: string;
    customInstructions?: string;
    tokenCount: number;
    truncated: boolean;
    truncationInfo?: string;
}

export type TemplateName =
    | "documentation"
    | "memorization"
    | "short-memory"
    | "changelog"
    | "debug-postmortem"
    | "onboarding"
    | "custom";

// =============================================================================
// Template Registry
// =============================================================================

const templateRegistry: Record<TemplateName, () => PromptTemplate> = {
    documentation: () => new DocumentationTemplate(),
    memorization: () => new MemorizationTemplate(),
    "short-memory": () => new ShortMemoryTemplate(),
    changelog: () => new ChangelogTemplate(),
    "debug-postmortem": () => new DebugPostmortemTemplate(),
    onboarding: () => new OnboardingTemplate(),
    custom: () => new CustomTemplate(),
};

// =============================================================================
// Factory & Listing
// =============================================================================

/**
 * Get a prompt template by name.
 * Throws if the template name is not recognized.
 */
export function getTemplate(mode: TemplateName | string): PromptTemplate {
    const factory = templateRegistry[mode as TemplateName];
    if (!factory) {
        const available = Object.keys(templateRegistry).join(", ");
        throw new Error(`Unknown template "${mode}". Available templates: ${available}`);
    }
    return factory();
}

/**
 * List all available templates with their names and descriptions.
 */
export function listTemplates(): Array<{ name: TemplateName; description: string }> {
    return (Object.entries(templateRegistry) as Array<[TemplateName, () => PromptTemplate]>).map(([name, factory]) => {
        const template = factory();
        return { name, description: template.description };
    });
}

// =============================================================================
// Shared Helpers
// =============================================================================

/**
 * Build the common session metadata block used by all templates.
 */
export function buildMetadataBlock(ctx: TemplateContext): string {
    const lines: string[] = [
        "## Session Information",
        `- **Session ID:** ${ctx.sessionId}`,
        `- **Date:** ${ctx.sessionDate}`,
    ];

    if (ctx.gitBranch) {
        lines.push(`- **Branch:** ${ctx.gitBranch}`);
    }
    if (ctx.projectName) {
        lines.push(`- **Project:** ${ctx.projectName}`);
    }
    if (ctx.sessionTitle) {
        lines.push(`- **Topic:** ${ctx.sessionTitle}`);
    }

    lines.push(`- **Content size:** ~${ctx.tokenCount.toLocaleString()} tokens`);

    if (ctx.truncated) {
        lines.push(
            `\n> **Warning:** This session was truncated. ${ctx.truncationInfo ?? "Some content may be missing from the beginning or middle of the session."}`
        );
    }

    return lines.join("\n");
}
