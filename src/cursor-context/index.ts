#!/usr/bin/env bun

import logger from "@app/logger";
import { ExitPromptError } from "@inquirer/core";
import { checkbox, confirm, input } from "@inquirer/prompts";
import clipboardy from "clipboardy";
import { Command } from "commander";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

interface ToolUseBlock {
    toolName: string;
    startIndex: number;
    endIndex: number;
    parametersStart?: number;
    parametersEnd?: number;
    resultStart?: number;
    resultEnd?: number;
    statusStart?: number;
}

function showHelp() {
    logger.info(`
Usage: tools cursor-context [options] [file]

Description:
  Parse a SpecStory file and remove selected tool-use inputs/outputs interactively.
  You can remove tool inputs (parameters), outputs (results), or both.
  The cleaned content will be copied to clipboard and optionally saved to a file.

Arguments:
  [file]              Path to the SpecStory file (default: logs/story.log)

Options:
  -i, --input FILE    Input SpecStory file path
  -o, --output FILE   Output file path (optional, defaults to clipboard only)
  -?, --help-full     Show this help message

Examples:
  tools cursor-context
  tools cursor-context logs/story.log
  tools cursor-context logs/story.log -o cleaned.log
`);
}

/**
 * Find the attribute value in an HTML-like tag
 */
function getAttributeValue(tag: string, attrName: string): string | null {
    const attrPattern = `${attrName}="`;
    const startIdx = tag.indexOf(attrPattern);
    if (startIdx === -1) return null;

    const valueStart = startIdx + attrPattern.length;
    const valueEnd = tag.indexOf('"', valueStart);
    if (valueEnd === -1) return null;

    return tag.substring(valueStart, valueEnd);
}

/**
 * Find the end of a code block (```)
 */
function findCodeBlockEnd(content: string, startIndex: number): number {
    const codeBlockStart = content.indexOf("```", startIndex);
    if (codeBlockStart === -1) return -1;

    // Find the closing ```
    let pos = codeBlockStart + 3;
    while (pos < content.length) {
        const nextBacktick = content.indexOf("```", pos);
        if (nextBacktick === -1) return -1;
        pos = nextBacktick + 3;
        // Check if this is actually a closing backtick (not part of content)
        // Simple check: if there's a newline before it, it's likely the end
        if (nextBacktick > 0 && content[nextBacktick - 1] === "\n") {
            return pos;
        }
    }
    return -1;
}

/**
 * Parse all tool-use blocks from the content
 */
function parseToolUseBlocks(content: string): ToolUseBlock[] {
    const blocks: ToolUseBlock[] = [];
    let pos = 0;

    while (pos < content.length) {
        // Find opening <tool-use tag
        const openTagStart = content.indexOf("<tool-use", pos);
        if (openTagStart === -1) break;

        // Find the end of the opening tag
        const openTagEnd = content.indexOf(">", openTagStart);
        if (openTagEnd === -1) break;

        const openTag = content.substring(openTagStart, openTagEnd + 1);
        const toolName = getAttributeValue(openTag, "data-tool-name");

        if (!toolName) {
            pos = openTagEnd + 1;
            continue;
        }

        // Find the closing </tool-use> tag
        const closeTagStart = content.indexOf("</tool-use>", openTagEnd);
        if (closeTagStart === -1) break;

        const closeTagEnd = closeTagStart + "</tool-use>".length;

        const block: ToolUseBlock = {
            toolName,
            startIndex: openTagStart,
            endIndex: closeTagEnd,
        };

        // Find Parameters section
        const parametersLabel = content.indexOf("Parameters:", openTagEnd);
        if (parametersLabel !== -1 && parametersLabel < closeTagStart) {
            block.parametersStart = parametersLabel;
            // Find the end of the code block after Parameters
            const codeBlockEnd = findCodeBlockEnd(content, parametersLabel);
            if (codeBlockEnd !== -1) {
                // Find the next newline after the code block
                let endPos = codeBlockEnd;
                while (endPos < content.length && content[endPos] === "\n") {
                    endPos++;
                }
                block.parametersEnd = endPos;
            }
        }

        // Find Result section
        const resultLabel = content.indexOf("Result:", openTagEnd);
        if (resultLabel !== -1 && resultLabel < closeTagStart) {
            block.resultStart = resultLabel;
            // Find the end of the code block after Result
            const codeBlockEnd = findCodeBlockEnd(content, resultLabel);
            if (codeBlockEnd !== -1) {
                // Find the next newline after the code block
                let endPos = codeBlockEnd;
                while (endPos < content.length && content[endPos] === "\n") {
                    endPos++;
                }
                block.resultEnd = endPos;
            }
        }

        // Find Status section
        const statusLabel = content.indexOf("Status:", openTagEnd);
        if (statusLabel !== -1 && statusLabel < closeTagStart) {
            block.statusStart = statusLabel;
        }

        blocks.push(block);
        pos = closeTagEnd;
    }

    return blocks;
}

/**
 * Extract all unique tool names from parsed blocks
 */
function extractToolNames(blocks: ToolUseBlock[]): string[] {
    const toolNames = new Set<string>();
    for (const block of blocks) {
        toolNames.add(block.toolName);
    }
    return Array.from(toolNames).sort();
}

/**
 * Remove sections from content based on parsed blocks and removal instructions
 */
function removeSections(
    content: string,
    blocks: ToolUseBlock[],
    removeInputs: Set<string>,
    removeOutputs: Set<string>,
    removeBoth: Set<string>
): string {
    // Sort blocks by start index in reverse order so we can remove from end to start
    // This prevents index shifting issues
    const sortedBlocks = [...blocks].sort((a, b) => b.startIndex - a.startIndex);

    let result = content;

    for (const block of sortedBlocks) {
        const toolName = block.toolName;

        // If both input and output should be removed, remove entire block
        if (removeBoth.has(toolName)) {
            result = result.substring(0, block.startIndex) + result.substring(block.endIndex);
            continue;
        }

        // Remove output if requested
        if (removeOutputs.has(toolName) && block.resultStart !== undefined && block.resultEnd !== undefined) {
            result = result.substring(0, block.resultStart) + result.substring(block.resultEnd);
            // Adjust indices for subsequent blocks (they're processed in reverse, so this is fine)
            continue;
        }

        // Remove input if requested
        if (removeInputs.has(toolName) && block.parametersStart !== undefined && block.parametersEnd !== undefined) {
            result = result.substring(0, block.parametersStart) + result.substring(block.parametersEnd);
        }
    }

    // Clean up multiple consecutive empty lines (more than 2)
    result = result.replace(/\n{3,}/g, "\n\n");

    return result;
}

async function main() {
    const program = new Command()
        .name("cursor-context")
        .argument("[file]", "Path to the SpecStory file", "logs/story.log")
        .option("-i, --input <file>", "Input SpecStory file path")
        .option("-o, --output <file>", "Output file path")
        .option("-?, --help-full", "Show this help message")
        .parse();

    const options = program.opts();
    const [fileArg] = program.args;

    if (options.helpFull) {
        showHelp();
        process.exit(0);
    }

    // Get input file path
    let inputPath = options.input || fileArg || "logs/story.log";
    inputPath = resolve(inputPath);

    try {
        // Read the file
        logger.info(`Reading file: ${inputPath}`);
        const content = readFileSync(inputPath, "utf-8");

        // Parse tool-use blocks
        logger.info("Parsing tool-use blocks...");
        const blocks = parseToolUseBlocks(content);
        logger.info(`Found ${blocks.length} tool-use blocks`);

        if (blocks.length === 0) {
            logger.info("No tool-use blocks found in the file.");
            process.exit(0);
        }

        // Extract tool names
        const toolNames = extractToolNames(blocks);
        logger.info(`Found ${toolNames.length} unique tool types`);

        // Build choices: for each tool, show input and output as separate options
        const choices: Array<{ value: string; name: string; checked?: boolean }> = [];
        for (const toolName of toolNames) {
            choices.push({
                value: `${toolName}:input`,
                name: `${toolName} (input)`,
            });
            choices.push({
                value: `${toolName}:output`,
                name: `${toolName} (output)`,
            });
        }

        // Show tool names and let user select which to remove
        const selectedItems = await checkbox({
            message: "Select tool inputs/outputs to remove (use space to select, enter to confirm):",
            choices,
        });

        if (!selectedItems || selectedItems.length === 0) {
            logger.info("No items selected for removal. Exiting.");
            process.exit(0);
        }

        // Separate inputs and outputs
        const toolsToRemoveInputs: string[] = [];
        const toolsToRemoveOutputs: string[] = [];
        const toolsToRemoveBoth: string[] = [];

        for (const item of selectedItems) {
            const [toolName, type] = item.split(":");
            if (type === "input") {
                toolsToRemoveInputs.push(toolName);
            } else if (type === "output") {
                toolsToRemoveOutputs.push(toolName);
            }
        }

        // Check for tools that have both input and output selected
        const allSelectedTools = new Set([...toolsToRemoveInputs, ...toolsToRemoveOutputs]);
        for (const tool of allSelectedTools) {
            if (toolsToRemoveInputs.includes(tool) && toolsToRemoveOutputs.includes(tool)) {
                toolsToRemoveBoth.push(tool);
            }
        }

        // Remove tools that have both selected (remove entire block)
        const toolsToRemoveInputsOnly = toolsToRemoveInputs.filter((t) => !toolsToRemoveBoth.includes(t));
        const toolsToRemoveOutputsOnly = toolsToRemoveOutputs.filter((t) => !toolsToRemoveBoth.includes(t));

        logger.info(`Removing:`);
        if (toolsToRemoveBoth.length > 0) {
            logger.info(`  Entire blocks: ${toolsToRemoveBoth.join(", ")}`);
        }
        if (toolsToRemoveInputsOnly.length > 0) {
            logger.info(`  Inputs only: ${toolsToRemoveInputsOnly.join(", ")}`);
        }
        if (toolsToRemoveOutputsOnly.length > 0) {
            logger.info(`  Outputs only: ${toolsToRemoveOutputsOnly.join(", ")}`);
        }

        // Process removals
        const cleaned = removeSections(
            content,
            blocks,
            new Set(toolsToRemoveInputsOnly),
            new Set(toolsToRemoveOutputsOnly),
            new Set(toolsToRemoveBoth)
        );

        // Show statistics
        const originalLines = content.split("\n").length;
        const cleanedLines = cleaned.split("\n").length;
        const removedLines = originalLines - cleanedLines;
        const originalSize = Buffer.byteLength(content, "utf-8");
        const cleanedSize = Buffer.byteLength(cleaned, "utf-8");
        const removedSize = originalSize - cleanedSize;

        logger.info(`
Statistics:
  Original: ${originalLines} lines, ${(originalSize / 1024).toFixed(2)} KB
  Cleaned:  ${cleanedLines} lines, ${(cleanedSize / 1024).toFixed(2)} KB
  Removed:  ${removedLines} lines, ${(removedSize / 1024).toFixed(2)} KB
`);

        // Copy to clipboard
        await clipboardy.write(cleaned);
        logger.info("✔ Copied cleaned content to clipboard!");

        // Save to output file if specified
        if (options.output) {
            const outputPath = resolve(options.output);
            writeFileSync(outputPath, cleaned, "utf-8");
            logger.info(`✔ Saved cleaned content to: ${outputPath}`);
        } else {
            // Ask if user wants to save to file
            try {
                const saveToFile = await confirm({
                    message: "Save cleaned content to a file?",
                    default: false,
                });

                if (saveToFile) {
                    const outputPath = await input({
                        message: "Enter output file path:",
                        default: inputPath.replace(/\.(log|md)$/, ".cleaned.$1"),
                    });

                    const resolvedOutputPath = resolve(outputPath);
                    writeFileSync(resolvedOutputPath, cleaned, "utf-8");
                    logger.info(`✔ Saved cleaned content to: ${resolvedOutputPath}`);
                }
            } catch (error: any) {
                if (error instanceof ExitPromptError) {
                    // User cancelled, that's fine
                    return;
                }
                throw error;
            }
        }
    } catch (error: any) {
        if (error instanceof ExitPromptError) {
            logger.info("\nOperation cancelled by user.");
            process.exit(0);
        }
        logger.error(`\n✖ Error: ${error.message}`);
        if (error.stack) {
            logger.error(error.stack);
        }
        process.exit(1);
    }
}

main().catch((err) => {
    logger.error(`\n✖ Unexpected error: ${err}`);
    process.exit(1);
});
