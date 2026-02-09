import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import logger from "@app/logger";
import type { OutputConfig, OutputFormat } from "@ask/types";
import { write } from "bun";
import chalk from "chalk";
import clipboardy from "clipboardy";

export interface FormattedResponse {
    content: string;
    format: OutputFormat;
    metadata?: Record<string, any>;
}

export class OutputManager {
    private currentConfig: OutputConfig = { type: "text" };

    constructor(initialConfig?: OutputConfig) {
        if (initialConfig) {
            this.currentConfig = initialConfig;
        }
    }

    setOutputFormat(config: OutputConfig): void {
        this.currentConfig = config;
        logger.info(`Output format changed to: ${config.type}${config.filename ? ` (${config.filename})` : ""}`);
    }

    getOutputFormat(): OutputConfig {
        return { ...this.currentConfig };
    }

    async handleOutput(content: string, format?: OutputConfig, metadata?: Record<string, any>): Promise<void> {
        const config = format || this.currentConfig;

        try {
            switch (config.type) {
                case "text":
                    await this.outputText(content, metadata);
                    break;

                case "json":
                    await this.outputJSON(content, metadata);
                    break;

                case "markdown":
                    await this.outputMarkdown(content, metadata);
                    break;

                case "clipboard":
                    await this.outputToClipboard(content, metadata);
                    break;

                case "file":
                    if (!config.filename) {
                        throw new Error("Filename is required for file output");
                    }
                    await this.outputToFile(content, config.filename, metadata);
                    break;

                default:
                    throw new Error(`Unsupported output format: ${config.type}`);
            }
        } catch (error) {
            logger.error(`Failed to handle output: ${error}`);
            throw error;
        }
    }

    private async outputText(content: string, metadata?: Record<string, any>): Promise<void> {
        if (metadata) {
            // Add metadata as header for text format
            const metadataText = this.formatMetadata(metadata, "text");
            console.log(metadataText);
        }

        console.log(content);
    }

    private async outputJSON(content: string, metadata?: Record<string, any>): Promise<void> {
        const response = {
            content,
            timestamp: new Date().toISOString(),
            ...(metadata && { metadata }),
        };

        const jsonOutput = JSON.stringify(response, null, 2);
        console.log(jsonOutput);
    }

    private async outputMarkdown(content: string, metadata?: Record<string, any>): Promise<void> {
        let markdown = "";

        if (metadata) {
            markdown += this.formatMetadata(metadata, "markdown") + "\n\n";
        }

        // Convert content to markdown if it's not already
        markdown += this.ensureMarkdownFormat(content);

        console.log(markdown);
    }

    private async outputToClipboard(content: string, metadata?: Record<string, any>): Promise<void> {
        try {
            let clipboardContent = content;

            if (metadata) {
                // Add metadata as comment at the top
                const metadataText = this.formatMetadata(metadata, "clipboard");
                clipboardContent = metadataText + "\n\n" + content;
            }

            await clipboardy.write(clipboardContent);
            console.log(chalk.green("✓ Content copied to clipboard"));

            if (metadata) {
                console.log(chalk.gray("Metadata included in clipboard content"));
            }
        } catch (error) {
            logger.error(`Failed to copy to clipboard: ${error}`);
            throw error;
        }
    }

    private async outputToFile(content: string, filename: string, metadata?: Record<string, any>): Promise<void> {
        try {
            const filePath = resolve(filename);
            const fileDir = dirname(filePath);

            // Create directory if it doesn't exist
            if (!existsSync(fileDir)) {
                mkdirSync(fileDir, { recursive: true });
                logger.info(`Created directory: ${fileDir}`);
            }

            let fileContent = content;

            if (metadata) {
                // Determine format based on file extension
                const ext = this.getFileExtension(filename);
                let format: "text" | "json" | "markdown" = "text";

                if (ext === ".json") format = "json";
                else if (ext === ".md" || ext === ".markdown") format = "markdown";

                const metadataText = this.formatMetadata(metadata, format);
                fileContent = metadataText + "\n\n" + content;
            }

            await write(filePath, fileContent);
            console.log(chalk.green(`✓ Content saved to ${filePath}`));

            // Show file size
            const stats = Bun.file(filePath);
            const size = this.formatFileSize(stats.size);
            console.log(chalk.gray(`File size: ${size}`));
        } catch (error) {
            logger.error(`Failed to write to file ${filename}: ${error}`);
            throw error;
        }
    }

    private formatMetadata(metadata: Record<string, any>, format: "text" | "json" | "markdown" | "clipboard"): string {
        switch (format) {
            case "text":
                return this.formatMetadataText(metadata);

            case "json":
                // For JSON, metadata is handled separately
                return "";

            case "markdown":
                return this.formatMetadataMarkdown(metadata);

            case "clipboard":
                return this.formatMetadataClipboard(metadata);

            default:
                return "";
        }
    }

    private formatMetadataText(metadata: Record<string, any>): string {
        const lines: string[] = [];
        lines.push("─".repeat(50));

        if (metadata.provider) {
            lines.push(`Provider: ${metadata.provider}`);
        }
        if (metadata.model) {
            lines.push(`Model: ${metadata.model}`);
        }
        if (metadata.cost) {
            lines.push(`Cost: $${metadata.cost.toFixed(4)}`);
        }
        if (metadata.tokens) {
            lines.push(`Tokens: ${this.formatTokens(metadata.tokens)}`);
        }
        if (metadata.timestamp) {
            lines.push(`Time: ${new Date(metadata.timestamp).toLocaleString()}`);
        }

        lines.push("─".repeat(50));
        return lines.join("\n");
    }

    private formatMetadataMarkdown(metadata: Record<string, any>): string {
        const lines: string[] = [];
        lines.push("---");

        if (metadata.provider) {
            lines.push(`**Provider:** ${metadata.provider}`);
        }
        if (metadata.model) {
            lines.push(`**Model:** ${metadata.model}`);
        }
        if (metadata.cost) {
            lines.push(`**Cost:** $${metadata.cost.toFixed(4)}`);
        }
        if (metadata.tokens) {
            lines.push(`**Tokens:** ${this.formatTokens(metadata.tokens)}`);
        }
        if (metadata.timestamp) {
            lines.push(`**Time:** ${new Date(metadata.timestamp).toLocaleString()}`);
        }

        lines.push("---");
        return lines.join("\n");
    }

    private formatMetadataClipboard(metadata: Record<string, any>): string {
        const lines: string[] = [];
        lines.push("# Generated Content");

        if (metadata.provider) {
            lines.push(`Provider: ${metadata.provider}`);
        }
        if (metadata.model) {
            lines.push(`Model: ${metadata.model}`);
        }
        if (metadata.cost) {
            lines.push(`Cost: $${metadata.cost.toFixed(4)}`);
        }
        if (metadata.tokens) {
            lines.push(`Tokens: ${this.formatTokens(metadata.tokens)}`);
        }
        if (metadata.timestamp) {
            lines.push(`Generated: ${new Date(metadata.timestamp).toLocaleString()}`);
        }

        lines.push("".repeat(50));
        return lines.join("\n");
    }

    private ensureMarkdownFormat(content: string): string {
        // Check if content is already markdown-like
        if (content.includes("##") || content.includes("**") || content.includes("*")) {
            return content;
        }

        // Convert plain text to basic markdown
        const lines = content.split("\n");
        const markdownLines: string[] = [];

        for (const line of lines) {
            const trimmed = line.trim();

            if (trimmed === "") {
                markdownLines.push("");
            } else if (!trimmed.startsWith("#") && !trimmed.startsWith(">") && !trimmed.startsWith("-")) {
                // Wrap paragraphs in proper formatting
                markdownLines.push(line);
            } else {
                markdownLines.push(line);
            }
        }

        return markdownLines.join("\n");
    }

    private getFileExtension(filename: string): string {
        const ext = filename.toLowerCase().split(".").pop();
        return ext ? `.${ext}` : "";
    }

    private formatFileSize(bytes: number): string {
        const units = ["B", "KB", "MB", "GB"];
        let size = bytes;
        let unitIndex = 0;

        while (size >= 1024 && unitIndex < units.length - 1) {
            size /= 1024;
            unitIndex++;
        }

        return `${size.toFixed(1)} ${units[unitIndex]}`;
    }

    private formatTokens(tokens: number): string {
        if (tokens >= 1000000) {
            return `${(tokens / 1000000).toFixed(1)}M`;
        } else if (tokens >= 1000) {
            return `${(tokens / 1000).toFixed(1)}K`;
        }
        return tokens.toString();
    }

    async formatCostBreakdown(
        breakdowns: Array<{
            provider: string;
            model: string;
            inputTokens: number;
            outputTokens: number;
            cachedInputTokens: number;
            totalTokens: number;
            cost: number;
            currency: string;
        }>
    ): Promise<string> {
        if (breakdowns.length === 0) {
            return "";
        }

        let output = "\n" + "=".repeat(60) + "\n";
        output += chalk.cyan("💰 COST BREAKDOWN\n");
        output += "=".repeat(60) + "\n\n";

        for (const breakdown of breakdowns) {
            output += chalk.white(`${breakdown.provider}/${breakdown.model}:\n`);

            if (breakdown.inputTokens > 0) {
                const inputCost = breakdown.cost * (breakdown.inputTokens / breakdown.totalTokens);
                output += `  Input:  ${this.formatTokens(breakdown.inputTokens)} (${chalk.yellow(
                    this.formatCost(inputCost)
                )})\n`;
            }

            if (breakdown.outputTokens > 0) {
                const outputCost = breakdown.cost * (breakdown.outputTokens / breakdown.totalTokens);
                output += `  Output: ${this.formatTokens(breakdown.outputTokens)} (${chalk.yellow(
                    this.formatCost(outputCost)
                )})\n`;
            }

            if (breakdown.cachedInputTokens > 0) {
                output += `  Cached: ${this.formatTokens(breakdown.cachedInputTokens)}\n`;
            }

            output += `  Total:  ${chalk.green(this.formatTokens(breakdown.totalTokens))} (${chalk.green(
                this.formatCost(breakdown.cost)
            )})\n\n`;
        }

        const totalCost = breakdowns.reduce((sum, bd) => sum + bd.cost, 0);
        output += chalk.white("Grand Total: ") + chalk.green.bold(this.formatCost(totalCost));
        output += "\n";

        // Cost alerts
        if (totalCost > 0.1) {
            output += chalk.yellow("⚠️  High cost alert: This session has exceeded $0.10\n");
        }

        return output;
    }

    private formatCost(cost: number): string {
        return `$${cost.toFixed(4)}`;
    }

    showOutputHelp(): void {
        console.log(chalk.cyan("\n📤 Output Formats:"));
        console.log();

        console.log(chalk.white("  text") + chalk.gray("        ") + "Plain text output with metadata header");
        console.log(chalk.white("  json") + chalk.gray("        ") + "Structured JSON with metadata");
        console.log(chalk.white("  markdown") + chalk.gray("    ") + "Markdown formatted with metadata");
        console.log(chalk.white("  clipboard") + chalk.gray("   ") + "Copy to system clipboard");
        console.log(chalk.white("  file") + chalk.gray("         ") + "Save to file (format based on extension)");
        console.log();

        console.log(chalk.yellow("💡 Examples:"));
        console.log(chalk.gray("  /output text           # Plain text"));
        console.log(chalk.gray("  /output json           # JSON format"));
        console.log(chalk.gray("  /output file chat.txt  # Save to file"));
        console.log(chalk.gray("  /output file resp.json # Save as JSON"));
        console.log(chalk.gray("  /output file out.md    # Save as Markdown"));
        console.log();
    }

    isTTY(): boolean {
        return process.stdout.isTTY;
    }

    stripAnsiCodes(text: string): string {
        // Remove ANSI color codes for non-TTY output
        return text.replace(/\x1b\[[0-9;]*m/g, "");
    }
}

// Singleton instance
export const outputManager = new OutputManager();
