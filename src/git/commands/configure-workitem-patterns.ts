/**
 * Git Configure Workitem Patterns Command
 *
 * Manage regex patterns for extracting workitem IDs from commit messages and branches.
 * Supports list/add/remove/suggest flags and interactive management.
 *
 * Usage:
 *   tools git configure-workitem-patterns                    # interactive (default)
 *   tools git configure-workitem-patterns --list             # show current patterns
 *   tools git configure-workitem-patterns --add '<regex>'    # add a pattern
 *   tools git configure-workitem-patterns --remove <index>   # remove by index
 *   tools git configure-workitem-patterns --suggest [--repo <path>]
 */

import {
    loadWorkitemPatternsAsync,
    suggestPatterns,
    validatePattern,
    type WorkitemPattern,
} from "@app/git/workitem-patterns";
import { createGit } from "@app/utils/git";
import type { Storage } from "@app/utils/storage";
import * as p from "@clack/prompts";
import chalk from "chalk";
import type { Command } from "commander";

interface ConfigurePatternsOptions {
    list?: boolean;
    add?: string;
    remove?: string;
    suggest?: boolean;
    repo?: string;
}

function formatPatternForDisplay(pattern: WorkitemPattern, index: number): string {
    const desc = pattern.description ? chalk.dim(` (${pattern.description})`) : "";
    const source = chalk.cyan(pattern.source);
    return `  ${chalk.dim(`[${index}]`)} ${chalk.yellow(pattern.regex)} ${source} group=${pattern.captureGroup}${desc}`;
}

async function getCommitMessages(repoPath: string, limit: number): Promise<{ messages: string[]; branches: string[] }> {
    const git = createGit({ cwd: repoPath });
    const executor = git.executor;

    const logResult = await executor.exec(["log", "--all", `-${limit}`, "--pretty=format:%s"]);

    const messages = logResult.success ? logResult.stdout.split("\n").filter((l) => l.trim()) : [];

    const branchResult = await executor.exec(["for-each-ref", "--format=%(refname:short)", "refs/heads/"]);

    const branches = branchResult.success ? branchResult.stdout.split("\n").filter((l) => l.trim()) : [];

    return { messages, branches };
}

async function handleSuggest(storage: Storage, repoPath: string): Promise<void> {
    const spinner = p.spinner();
    spinner.start(`Analyzing commits in ${repoPath}...`);

    const { messages, branches } = await getCommitMessages(repoPath, 200);
    const suggestions = suggestPatterns(messages, branches);

    spinner.stop(`Analyzed ${messages.length} commits and ${branches.length} branches`);

    if (suggestions.length === 0) {
        p.log.warn("No matching patterns detected in commit history.");
        return;
    }

    const selected = await p.multiselect({
        message: "Select patterns to add:",
        options: suggestions.map((s, i) => ({
            value: i,
            label: `"${s.pattern.regex}" - ${s.matchCount} matches (${s.pattern.source})`,
            hint: `e.g. ${s.sampleMatches.join(", ")}`,
        })),
    });

    if (p.isCancel(selected)) {
        p.cancel("Operation cancelled.");
        return;
    }

    const currentPatterns = (await storage.getConfigValue<WorkitemPattern[]>("workitemPatterns")) ?? [];
    const newPatterns = [...currentPatterns];

    for (const idx of selected as number[]) {
        const suggestion = suggestions[idx];
        const alreadyExists = newPatterns.some(
            (p) => p.regex === suggestion.pattern.regex && p.source === suggestion.pattern.source
        );

        if (!alreadyExists) {
            newPatterns.push(suggestion.pattern);
            p.log.success(`Added: ${suggestion.pattern.regex} (${suggestion.pattern.source})`);
        } else {
            p.log.info(`Skipped (already exists): ${suggestion.pattern.regex}`);
        }
    }

    await storage.setConfigValue("workitemPatterns", newPatterns);
    p.log.success(`Saved ${newPatterns.length} pattern(s) to config.`);
}

async function handleList(storage: Storage): Promise<void> {
    const patterns = (await storage.getConfigValue<WorkitemPattern[]>("workitemPatterns")) ?? [];

    if (patterns.length === 0) {
        console.log(chalk.dim("No custom patterns configured. Using defaults:"));
        const defaults = await loadWorkitemPatternsAsync();
        for (let i = 0; i < defaults.length; i++) {
            console.log(formatPatternForDisplay(defaults[i], i));
        }
    } else {
        console.log(chalk.bold("Configured workitem patterns:"));
        for (let i = 0; i < patterns.length; i++) {
            console.log(formatPatternForDisplay(patterns[i], i));
        }
    }
}

async function handleAdd(storage: Storage, regex: string): Promise<void> {
    const validation = validatePattern(regex);

    if (!validation.valid) {
        console.log(chalk.red(`Invalid pattern: ${validation.error}`));
        process.exit(1);
    }

    const currentPatterns = (await storage.getConfigValue<WorkitemPattern[]>("workitemPatterns")) ?? [];

    const newPattern: WorkitemPattern = {
        regex,
        source: "commit-message",
        captureGroup: 1,
    };

    const alreadyExists = currentPatterns.some((p) => p.regex === regex);

    if (alreadyExists) {
        console.log(chalk.yellow(`Pattern "${regex}" already exists.`));
        return;
    }

    currentPatterns.push(newPattern);
    await storage.setConfigValue("workitemPatterns", currentPatterns);
    console.log(chalk.green(`Added pattern: ${regex}`));
    console.log(chalk.dim(`Total patterns: ${currentPatterns.length}`));
}

async function handleRemove(storage: Storage, indexStr: string): Promise<void> {
    const index = parseInt(indexStr, 10);
    const currentPatterns = (await storage.getConfigValue<WorkitemPattern[]>("workitemPatterns")) ?? [];

    if (Number.isNaN(index) || index < 0 || index >= currentPatterns.length) {
        console.log(chalk.red(`Invalid index: ${indexStr}. Valid range: 0-${currentPatterns.length - 1}`));
        process.exit(1);
    }

    const removed = currentPatterns.splice(index, 1)[0];
    await storage.setConfigValue("workitemPatterns", currentPatterns);
    console.log(chalk.green(`Removed pattern: ${removed.regex}`));
    console.log(chalk.dim(`Remaining patterns: ${currentPatterns.length}`));
}

async function handleInteractive(storage: Storage): Promise<void> {
    p.intro(chalk.bold("Configure Workitem Patterns"));

    const currentPatterns = (await storage.getConfigValue<WorkitemPattern[]>("workitemPatterns")) ?? [];

    if (currentPatterns.length > 0) {
        p.log.info("Current patterns:");
        for (let i = 0; i < currentPatterns.length; i++) {
            p.log.message(formatPatternForDisplay(currentPatterns[i], i));
        }
    } else {
        p.log.info("No custom patterns configured (using defaults).");
    }

    let running = true;

    while (running) {
        const action = await p.select({
            message: "What would you like to do?",
            options: [
                { value: "add", label: "Add a new pattern" },
                {
                    value: "remove",
                    label: "Remove an existing pattern",
                    hint: currentPatterns.length === 0 ? "no patterns to remove" : undefined,
                },
                { value: "suggest", label: "Suggest patterns from repository" },
                { value: "done", label: "Done" },
            ],
        });

        if (p.isCancel(action)) {
            p.cancel("Operation cancelled.");
            process.exit(0);
        }

        switch (action) {
            case "add": {
                const regex = await p.text({
                    message: "Enter regex pattern (must have a capture group for the ID):",
                    placeholder: "col-(\\d+)",
                    validate: (value = "") => {
                        const result = validatePattern(value);

                        if (!result.valid) {
                            return result.error ?? "Invalid pattern";
                        }
                    },
                });

                if (p.isCancel(regex)) {
                    break;
                }

                const source = await p.select({
                    message: "Where should this pattern match?",
                    options: [
                        { value: "commit-message", label: "Commit messages" },
                        { value: "branch-name", label: "Branch names" },
                        { value: "both", label: "Both" },
                    ],
                });

                if (p.isCancel(source)) {
                    break;
                }

                const description = await p.text({
                    message: "Description (optional):",
                    placeholder: "My pattern",
                });

                if (p.isCancel(description)) {
                    break;
                }

                const newPattern: WorkitemPattern = {
                    regex: regex as string,
                    source: source as WorkitemPattern["source"],
                    captureGroup: 1,
                    description: (description as string) || undefined,
                };

                currentPatterns.push(newPattern);
                await storage.setConfigValue("workitemPatterns", currentPatterns);
                p.log.success(`Added: ${newPattern.regex}`);
                break;
            }

            case "remove": {
                if (currentPatterns.length === 0) {
                    p.log.warn("No patterns to remove.");
                    break;
                }

                const toRemove = await p.select({
                    message: "Select pattern to remove:",
                    options: currentPatterns.map((pat, i) => ({
                        value: i,
                        label: `${pat.regex} (${pat.source})`,
                        hint: pat.description,
                    })),
                });

                if (p.isCancel(toRemove)) {
                    break;
                }

                const removed = currentPatterns.splice(toRemove as number, 1)[0];
                await storage.setConfigValue("workitemPatterns", currentPatterns);
                p.log.success(`Removed: ${removed.regex}`);
                break;
            }

            case "suggest": {
                const repoPath = await p.text({
                    message: "Repository path:",
                    defaultValue: process.cwd(),
                    placeholder: process.cwd(),
                });

                if (p.isCancel(repoPath)) {
                    break;
                }

                await handleSuggest(storage, repoPath as string);
                break;
            }

            case "done":
                running = false;
                break;
        }
    }

    p.outro("Done");
}

async function handleConfigureWorkitemPatterns(storage: Storage, options: ConfigurePatternsOptions): Promise<void> {
    if (options.list) {
        await handleList(storage);
        return;
    }

    if (options.add) {
        await handleAdd(storage, options.add);
        return;
    }

    if (options.remove !== undefined) {
        await handleRemove(storage, options.remove);
        return;
    }

    if (options.suggest) {
        const repoPath = options.repo ?? process.cwd();
        p.intro(chalk.bold("Suggest Workitem Patterns"));
        await handleSuggest(storage, repoPath);
        p.outro("Done");
        return;
    }

    // Interactive mode (default)
    await handleInteractive(storage);
}

export function registerConfigureWorkitemPatternsCommand(parent: Command, storage: Storage): void {
    parent
        .command("configure-workitem-patterns")
        .alias("patterns")
        .description("Manage regex patterns for extracting workitem IDs")
        .option("--list", "List current patterns")
        .option("--add <regex>", "Add a new pattern")
        .option("--remove <index>", "Remove pattern by index")
        .option("--suggest", "Suggest patterns from repository history")
        .option("--repo <path>", "Repository path for --suggest (default: cwd)")
        .action(async (options: ConfigurePatternsOptions) => {
            await handleConfigureWorkitemPatterns(storage, options);
        });
}
