/**
 * SummarizeEngine — Orchestrates session summarization via LLM.
 *
 * Pipeline: extractContent -> buildPrompt -> callLLM -> formatOutput
 * Supports streaming, chunked (thorough) mode, and multiple output targets.
 */

import { generateText, streamText } from "ai";
import type { LanguageModelUsage } from "ai";
import { providerManager } from "@ask/providers/ProviderManager";
import { modelSelector } from "@ask/providers/ModelSelector";
import { getLanguageModel } from "@ask/types/provider";
import { dynamicPricingManager } from "@ask/providers/DynamicPricing";
import { estimateTokens } from "@app/utils/tokens";
import type { ClaudeSession, PreparedContent } from "@app/utils/claude/session";
import { getTemplate, listTemplates } from "./templates/index.ts";
import type { TemplateContext, PromptTemplate } from "./templates/index.ts";
import type { ProviderChoice } from "@ask/types";
import clipboardy from "clipboardy";
import { writeFile, mkdir } from "fs/promises";
import { dirname, resolve } from "path";

// =============================================================================
// Types
// =============================================================================

export interface SummarizeOptions {
    session: ClaudeSession;
    mode: string;
    customPrompt?: string;

    // LLM config
    provider?: string;
    model?: string;
    streaming?: boolean;
    promptOnly?: boolean;

    // Content config
    tokenBudget?: number;
    includeToolResults?: boolean;
    includeThinking?: boolean;
    priority?: "balanced" | "user-first" | "assistant-first";

    // Chunking
    thorough?: boolean;
    chunkSize?: number;

    // Output
    outputPath?: string;
    clipboard?: boolean;
    memoryDir?: string;
}

export interface SummarizeResult {
    content: string;
    mode: string;
    tokenUsage?: { input: number; output: number };
    cost?: number;
    truncated: boolean;
    truncationInfo?: string;
    outputPaths: string[];
}

interface LLMCallResult {
    content: string;
    usage?: LanguageModelUsage;
}

// =============================================================================
// Engine
// =============================================================================

export class SummarizeEngine {
    private readonly options: SummarizeOptions;
    private template: PromptTemplate;

    constructor(options: SummarizeOptions) {
        this.options = options;
        this.template = getTemplate(options.mode);
    }

    // =========================================================================
    // Pipeline Step 1: Extract content from session
    // =========================================================================

    private extractContent(): PreparedContent {
        const { session, tokenBudget = 128_000, includeToolResults, includeThinking, priority = "balanced" } = this.options;

        return session.toPromptContent({
            tokenBudget,
            priority,
            includeToolResults,
            includeThinking,
        });
    }

    // =========================================================================
    // Pipeline Step 2: Build prompt from template
    // =========================================================================

    private buildPrompt(prepared: PreparedContent): { systemPrompt: string; userPrompt: string } {
        const { session, customPrompt } = this.options;

        const context: TemplateContext = {
            sessionContent: prepared.content,
            sessionId: session.sessionId ?? "unknown",
            sessionDate: session.startDate?.toISOString().split("T")[0] ?? "unknown",
            gitBranch: session.gitBranch ?? undefined,
            projectName: session.project ?? undefined,
            sessionTitle: session.title ?? session.summary ?? undefined,
            customInstructions: customPrompt,
            tokenCount: prepared.tokenCount,
            truncated: prepared.truncated,
            truncationInfo: prepared.truncationInfo,
        };

        const systemPrompt = this.template.systemPrompt;
        const userPrompt = this.template.buildUserPrompt(context);

        return { systemPrompt, userPrompt };
    }

    // =========================================================================
    // Pipeline Step 3: Call LLM (streaming or non-streaming)
    // =========================================================================

    private async resolveModel(): Promise<ProviderChoice> {
        const { provider: providerName, model: modelName } = this.options;

        // If provider and/or model specified via CLI, use selectModelByName
        if (providerName || modelName) {
            const choice = await modelSelector.selectModelByName(providerName, modelName);
            if (!choice) {
                throw new Error(
                    `Could not resolve model${modelName ? ` "${modelName}"` : ""}${providerName ? ` from provider "${providerName}"` : ""}. Check available providers and models.`
                );
            }
            return choice;
        }

        // Interactive selection
        if (process.stdout.isTTY) {
            const choice = await modelSelector.selectModel();
            if (!choice) {
                throw new Error("Model selection cancelled.");
            }
            return choice;
        }

        // Non-TTY fallback: auto-select first available
        const providers = await providerManager.detectProviders();
        if (providers.length === 0) {
            throw new Error("No AI providers detected. Please set API keys in environment variables.");
        }
        const firstProvider = providers[0];
        const firstModel = firstProvider.models[0];
        if (!firstModel) {
            throw new Error(`Provider "${firstProvider.name}" has no available models.`);
        }
        return { provider: firstProvider, model: firstModel };
    }

    private async callLLM(
        systemPrompt: string,
        userPrompt: string,
        providerChoice: ProviderChoice,
        streaming: boolean,
    ): Promise<LLMCallResult> {
        const model = getLanguageModel(providerChoice.provider.provider, providerChoice.model.id);

        if (streaming) {
            const result = await streamText({
                model,
                system: systemPrompt,
                prompt: userPrompt,
            });

            let fullResponse = "";
            for await (const chunk of result.textStream) {
                process.stdout.write(chunk);
                fullResponse += chunk;
            }
            // Final newline after streaming
            process.stdout.write("\n");

            const usage = await result.usage;
            return { content: fullResponse, usage };
        }

        const result = await generateText({
            model,
            system: systemPrompt,
            prompt: userPrompt,
        });

        return { content: result.text, usage: result.usage };
    }

    // =========================================================================
    // Pipeline Step 4: Format and write output
    // =========================================================================

    private async formatOutput(content: string): Promise<string[]> {
        const { outputPath, clipboard, memoryDir, mode } = this.options;
        const outputPaths: string[] = [];

        // Write to file
        if (outputPath) {
            const resolvedPath = resolve(outputPath);
            await mkdir(dirname(resolvedPath), { recursive: true });
            await writeFile(resolvedPath, content, "utf-8");
            outputPaths.push(resolvedPath);
        }

        // Copy to clipboard
        if (clipboard) {
            await clipboardy.write(content);
        }

        // For memorization mode: parse topic tags and write separate files
        if (mode === "memorization" && memoryDir) {
            const topicFiles = this.parseMemorizationTopics(content);
            const resolvedMemDir = resolve(memoryDir);
            await mkdir(resolvedMemDir, { recursive: true });

            for (const [topic, topicContent] of topicFiles) {
                const filePath = resolve(resolvedMemDir, `${topic}.md`);
                await writeFile(filePath, topicContent, "utf-8");
                outputPaths.push(filePath);
            }
        }

        return outputPaths;
    }

    /**
     * Parse memorization template output into topic-tagged sections.
     * Expects `## [topic-tag]` headers as section delimiters.
     */
    private parseMemorizationTopics(content: string): Map<string, string> {
        const topics = new Map<string, string>();
        const sectionPattern = /^## \[(\w[\w-]*)\]/gm;

        let lastTopic: string | null = null;
        let lastStart = 0;
        let match: RegExpExecArray | null;

        // Reset regex state
        sectionPattern.lastIndex = 0;

        while ((match = sectionPattern.exec(content)) !== null) {
            if (lastTopic !== null) {
                const sectionContent = content.slice(lastStart, match.index).trim();
                if (sectionContent) {
                    const existing = topics.get(lastTopic);
                    topics.set(lastTopic, existing ? `${existing}\n\n${sectionContent}` : sectionContent);
                }
            }
            lastTopic = match[1];
            lastStart = match.index;
        }

        // Capture the last section
        if (lastTopic !== null) {
            const sectionContent = content.slice(lastStart).trim();
            if (sectionContent) {
                const existing = topics.get(lastTopic);
                topics.set(lastTopic, existing ? `${existing}\n\n${sectionContent}` : sectionContent);
            }
        }

        return topics;
    }

    // =========================================================================
    // Chunked Summarization (--thorough)
    // =========================================================================

    private splitIntoChunks(text: string, chunkTokenSize: number): string[] {
        const chunks: string[] = [];
        // Approximate character count per chunk (~4 chars per token)
        const chunkCharSize = chunkTokenSize * 4;

        let offset = 0;
        while (offset < text.length) {
            let end = offset + chunkCharSize;

            // Try to split at a message boundary (double newline)
            if (end < text.length) {
                const boundarySearch = text.lastIndexOf("\n\n", end);
                if (boundarySearch > offset) {
                    end = boundarySearch + 2;
                }
            } else {
                end = text.length;
            }

            chunks.push(text.slice(offset, end));
            offset = end;
        }

        return chunks;
    }

    private async runChunkedSummarization(
        prepared: PreparedContent,
        providerChoice: ProviderChoice,
        streaming: boolean,
    ): Promise<LLMCallResult> {
        const chunkSize = this.options.chunkSize ?? 100_000;
        const chunks = this.splitIntoChunks(prepared.content, chunkSize);

        if (chunks.length <= 1) {
            // Content fits in a single chunk, use normal pipeline
            const { systemPrompt, userPrompt } = this.buildPrompt(prepared);
            return this.callLLM(systemPrompt, userPrompt, providerChoice, streaming);
        }

        // Phase 1: Summarize each chunk
        const chunkSummaries: string[] = [];
        let totalUsage: { inputTokens: number; outputTokens: number } = { inputTokens: 0, outputTokens: 0 };

        const chunkSystemPrompt =
            "You are summarizing a portion of a Claude Code development session. " +
            "Extract the key information, decisions, code changes, and learnings from this portion. " +
            "Be thorough and preserve specific details like file paths, function names, and code snippets.";

        for (let i = 0; i < chunks.length; i++) {
            const chunkPrompt = `This is chunk ${i + 1} of ${chunks.length} from a development session.\n\nSummarize this portion:\n\n${chunks[i]}`;

            if (streaming && process.stdout.isTTY) {
                process.stdout.write(`\n--- Chunk ${i + 1}/${chunks.length} ---\n`);
            }

            const result = await this.callLLM(chunkSystemPrompt, chunkPrompt, providerChoice, false);
            chunkSummaries.push(result.content);

            if (result.usage) {
                totalUsage.inputTokens += result.usage.inputTokens ?? 0;
                totalUsage.outputTokens += result.usage.outputTokens ?? 0;
            }
        }

        // Phase 2: Synthesis pass - combine chunk summaries with original template
        const { session, customPrompt } = this.options;
        const combinedContent = chunkSummaries.map((s, i) => `### Part ${i + 1}\n\n${s}`).join("\n\n---\n\n");

        const synthesisContext: TemplateContext = {
            sessionContent: combinedContent,
            sessionId: session.sessionId ?? "unknown",
            sessionDate: session.startDate?.toISOString().split("T")[0] ?? "unknown",
            gitBranch: session.gitBranch ?? undefined,
            projectName: session.project ?? undefined,
            sessionTitle: session.title ?? session.summary ?? undefined,
            customInstructions: customPrompt,
            tokenCount: estimateTokens(combinedContent),
            truncated: prepared.truncated,
            truncationInfo: `Processed in ${chunks.length} chunks. ${prepared.truncationInfo}`,
        };

        const synthesisSystem =
            this.template.systemPrompt +
            "\n\nNote: The session content below has been pre-summarized in chunks. " +
            "Synthesize these partial summaries into a single cohesive document.";
        const synthesisUser = this.template.buildUserPrompt(synthesisContext);

        const synthesisResult = await this.callLLM(synthesisSystem, synthesisUser, providerChoice, streaming);

        if (synthesisResult.usage) {
            totalUsage.inputTokens += synthesisResult.usage.inputTokens ?? 0;
            totalUsage.outputTokens += synthesisResult.usage.outputTokens ?? 0;
        }

        return {
            content: synthesisResult.content,
            usage: {
                inputTokens: totalUsage.inputTokens,
                outputTokens: totalUsage.outputTokens,
                totalTokens: totalUsage.inputTokens + totalUsage.outputTokens,
            } as LanguageModelUsage,
        };
    }

    // =========================================================================
    // Main Pipeline
    // =========================================================================

    async run(): Promise<SummarizeResult> {
        // Step 1: Extract content
        const prepared = this.extractContent();

        // Step 2: Build prompt
        const { systemPrompt, userPrompt } = this.buildPrompt(prepared);

        // If prompt-only mode, return the prompt without calling LLM
        if (this.options.promptOnly) {
            const fullPrompt = `=== SYSTEM PROMPT ===\n\n${systemPrompt}\n\n=== USER PROMPT ===\n\n${userPrompt}`;
            const outputPaths = await this.formatOutput(fullPrompt);

            // If no output target specified, write to stdout
            if (!this.options.outputPath && !this.options.clipboard) {
                process.stdout.write(fullPrompt + "\n");
            }

            return {
                content: fullPrompt,
                mode: this.options.mode,
                truncated: prepared.truncated,
                truncationInfo: prepared.truncationInfo,
                outputPaths,
            };
        }

        // Step 3: Resolve model
        const providerChoice = await this.resolveModel();

        // Determine streaming preference
        const streaming = this.options.streaming ?? (process.stdout.isTTY ? true : false);

        // Step 3b: Call LLM (normal or chunked)
        let llmResult: LLMCallResult;
        if (this.options.thorough) {
            llmResult = await this.runChunkedSummarization(prepared, providerChoice, streaming);
        } else {
            llmResult = await this.callLLM(systemPrompt, userPrompt, providerChoice, streaming);
        }

        // Step 4: Calculate cost
        let cost: number | undefined;
        if (llmResult.usage) {
            cost = await dynamicPricingManager.calculateCost(
                providerChoice.provider.name,
                providerChoice.model.id,
                llmResult.usage,
            );
        }

        // Step 5: Format output
        const outputPaths = await this.formatOutput(llmResult.content);

        // Write to stdout if non-streaming and no other output target
        if (!streaming && !this.options.outputPath && !this.options.clipboard) {
            process.stdout.write(llmResult.content + "\n");
        }

        // Build token usage
        const tokenUsage = llmResult.usage
            ? {
                  input: llmResult.usage.inputTokens ?? 0,
                  output: llmResult.usage.outputTokens ?? 0,
              }
            : undefined;

        return {
            content: llmResult.content,
            mode: this.options.mode,
            tokenUsage,
            cost,
            truncated: prepared.truncated,
            truncationInfo: prepared.truncationInfo,
            outputPaths,
        };
    }
}

// =============================================================================
// Convenience: list available modes
// =============================================================================

export { listTemplates };
