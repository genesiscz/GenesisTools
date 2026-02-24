import { checkLLMModel, convertToMarkdown, downloadLLMModel, type LLMModelStatus } from "@nanocollective/get-md";
import { MarkdownEngine } from "./base.js";
import type { ConversionOptions, ConversionResult, EngineName } from "./types.js";

/**
 * ReaderLM Engine - Uses @nanocollective/get-md with optional LLM support
 *
 * By default uses fast Readability + Turndown conversion.
 * When LLM model is available, uses ReaderLM-v2 for higher quality output.
 *
 * To download the model (~1GB):
 *   getmd --download-model
 * Or programmatically:
 *   await downloadLLMModel()
 */
export class ReaderLMEngine extends MarkdownEngine {
    name: EngineName = "readerlm";
    description = "get-md with ReaderLM-v2 - highest quality (requires model download)";

    private modelStatus: LLMModelStatus | null = null;

    /**
     * Check if the LLM model is available
     */
    async checkModel(): Promise<LLMModelStatus> {
        if (!this.modelStatus) {
            this.modelStatus = await checkLLMModel();
        }
        return this.modelStatus;
    }

    /**
     * Download the LLM model (~1GB)
     */
    async downloadModel(onProgress?: (downloaded: number, total: number, pct: number) => void): Promise<void> {
        await downloadLLMModel({ onProgress });
        this.modelStatus = null; // Reset to re-check
    }

    async convert(html: string, options: ConversionOptions): Promise<ConversionResult> {
        const start = performance.now();

        // Check if LLM model is available
        const status = await this.checkModel();

        if (!status.available) {
            throw new Error(
                `ReaderLM-v2 model not installed (~1GB).\n` +
                    `Model: https://huggingface.co/jinaai/ReaderLM-v2\n` +
                    `Add --download-model to your command to download and convert.`
            );
        }

        // Use get-md for conversion with LLM
        const result = await convertToMarkdown(html, {
            extractContent: true,
            aggressiveCleanup: true,
            includeMeta: false, // We'll add our own header
            baseUrl: options.baseUrl,
            useLLM: true,
            llmFallback: false, // Don't silently fall back
        });

        let markdown = result.markdown;

        // Normalize
        markdown = this.normalize(markdown);

        // Add metadata header for advanced mode
        if (options.depth === "advanced" && result.metadata?.title) {
            const header = this.buildHeader(result.metadata, options.baseUrl);
            markdown = header + markdown;
        }

        return {
            markdown,
            metadata: {
                title: result.metadata?.title,
                author: result.metadata?.author,
                publishedTime: result.metadata?.publishedTime,
                url: options.baseUrl,
            },
            metrics: {
                inputChars: html.length,
                outputChars: markdown.length,
                conversionTimeMs: performance.now() - start,
            },
        };
    }

    private buildHeader(meta: { title?: string; author?: string; publishedTime?: string }, url: string): string {
        const lines = ["---"];
        if (meta.title) {
            lines.push(`title: ${meta.title}`);
        }
        lines.push(`url: ${url}`);
        if (meta.author) {
            lines.push(`author: ${meta.author}`);
        }
        if (meta.publishedTime) {
            lines.push(`date: ${meta.publishedTime}`);
        }
        lines.push("---\n\n");
        return lines.join("\n");
    }
}

// Re-export for CLI usage
export { checkLLMModel, downloadLLMModel };
