/**
 * CLI command: `claude-history summarize [session-id]`
 *
 * Summarizes one or more Claude Code sessions using LLM-powered templates.
 * Supports interactive and non-interactive flows, streaming, chunked mode,
 * and multiple output targets (stdout, file, clipboard, memory dir).
 */

import { parseDate } from "@app/claude/lib/history/search";
import type { SummarizeOptions, SummarizeResult } from "@app/claude/lib/history/summarize/engine.ts";
import { listTemplates, SummarizeEngine } from "@app/claude/lib/history/summarize/engine.ts";
import { ClaudeSession } from "@app/utils/claude/session";
import { listAppleNotesFolders } from "@app/utils/macos/apple-notes";
import { dynamicPricingManager } from "@ask/providers/DynamicPricing";
import { modelSelector } from "@ask/providers/ModelSelector";
import * as p from "@clack/prompts";
import chalk from "chalk";
import type { Command } from "commander";

// =============================================================================
// Types
// =============================================================================

interface SummarizeCommandOptions {
    session?: string[];
    current?: boolean;
    since?: string;
    until?: string;
    mode?: string;
    model?: string;
    provider?: string;
    promptOnly?: boolean;
    output?: string;
    clipboard?: boolean;
    thorough?: boolean;
    maxTokens?: string;
    includeToolResults?: boolean;
    includeThinking?: boolean;
    priority?: string;
    interactive?: boolean;
    customPrompt?: string;
    memoryDir?: string;
    appleNotes?: boolean;
}

// =============================================================================
// Session Resolution
// =============================================================================

async function resolveSessionIds(
    positionalId: string | undefined,
    opts: SummarizeCommandOptions
): Promise<ClaudeSession[]> {
    // 1. Positional argument
    if (positionalId) {
        const session = await ClaudeSession.fromSessionId(positionalId);
        return [session];
    }

    // 2. Explicit --session flags (repeatable)
    if (opts.session && opts.session.length > 0) {
        const sessions: ClaudeSession[] = [];
        for (const id of opts.session) {
            sessions.push(await ClaudeSession.fromSessionId(id));
        }
        return sessions;
    }

    // 3. --current flag
    if (opts.current) {
        const envId = process.env.CLAUDE_CODE_SESSION_ID;
        if (!envId) {
            throw new Error(
                "CLAUDE_CODE_SESSION_ID environment variable is not set. " +
                    "Use --current only when running inside a Claude Code session."
            );
        }
        const session = await ClaudeSession.fromSessionId(envId);
        return [session];
    }

    // 4. --since / --until date range
    if (opts.since || opts.until) {
        const since = opts.since ? parseDate(opts.since) : undefined;
        const until = opts.until ? parseDate(opts.until) : undefined;
        const infos = await ClaudeSession.findSessions({ since, until });
        if (infos.length === 0) {
            throw new Error("No sessions found matching the specified date range.");
        }
        const sessions: ClaudeSession[] = [];
        for (const info of infos) {
            sessions.push(await ClaudeSession.fromFile(info.filePath));
        }
        return sessions;
    }

    // 5. Interactive mode (TTY only)
    if (process.stdout.isTTY) {
        return [await pickSessionInteractively()];
    }

    // 6. Non-interactive without session = error
    throw new Error(
        "No session specified. Use a positional argument, --session, --current, or --since/--until. " +
            "Run with -i for interactive mode."
    );
}

async function pickSessionInteractively(): Promise<ClaudeSession> {
    const sessions = await ClaudeSession.findSessions({ limit: 30 });

    if (sessions.length === 0) {
        throw new Error("No sessions found. Check that Claude Code sessions exist in ~/.claude/projects/");
    }

    const choices = sessions.map((info) => {
        const dateStr = info.startDate ? info.startDate.toISOString().split("T")[0] : "unknown";
        const title = info.title ?? info.summary ?? info.sessionId ?? "(unnamed)";
        const branchStr = info.gitBranch ? ` | ${info.gitBranch}` : "";
        const label = `${title} | ${dateStr}${branchStr}`;
        return {
            value: info.filePath,
            label,
            hint: info.sessionId?.slice(0, 8) ?? "",
        };
    });

    const selected = await p.select({
        message: "Select a session to summarize:",
        options: choices,
    });

    if (p.isCancel(selected)) {
        p.cancel("Cancelled.");
        process.exit(0);
    }

    return ClaudeSession.fromFile(selected as string);
}

// =============================================================================
// Apple Notes Folder Picker
// =============================================================================

async function pickAppleNotesFolder(): Promise<string> {
    const folders = listAppleNotesFolders();
    if (folders.length === 0) {
        throw new Error("No Apple Notes folders found.");
    }

    // Deduplicate by showing account name when there are name collisions
    const nameCount = new Map<string, number>();
    for (const f of folders) {
        nameCount.set(f.name, (nameCount.get(f.name) ?? 0) + 1);
    }

    const choices = folders
        .filter((f) => f.noteCount > 0 || !f.name.startsWith("Notes"))
        .map((f) => {
            const showAccount = (nameCount.get(f.name) ?? 0) > 1;
            const label = showAccount ? `${f.name} (${f.account})` : f.name;
            return {
                value: f.id,
                label,
                hint: `${f.noteCount} notes`,
            };
        });

    const selected = await p.select({
        message: "Select Apple Notes folder:",
        options: choices,
    });

    if (p.isCancel(selected)) {
        p.cancel("Cancelled.");
        process.exit(0);
    }

    return selected as string;
}

// =============================================================================
// Interactive Flow
// =============================================================================

async function runInteractiveFlow(session: ClaudeSession, opts: SummarizeCommandOptions): Promise<SummarizeOptions> {
    p.intro(chalk.cyan("Claude History Summarizer"));

    // Mode picker
    const templates = listTemplates();
    let mode = opts.mode;
    if (!mode) {
        const modeChoice = await p.select({
            message: "Select summarization mode:",
            options: templates.map((t) => ({
                value: t.name,
                label: t.name,
                hint: t.description,
            })),
        });
        if (p.isCancel(modeChoice)) {
            p.cancel("Cancelled.");
            process.exit(0);
        }
        mode = modeChoice as string;
    }

    // Custom prompt for custom mode
    let customPrompt = opts.customPrompt;
    if (mode === "custom" && !customPrompt) {
        const promptInput = await p.text({
            message: "Enter your custom summarization prompt:",
            placeholder: "e.g., Focus on the error handling patterns used...",
            validate: (val) => {
                if (!val || !val.trim()) return "Prompt cannot be empty for custom mode.";
            },
        });
        if (p.isCancel(promptInput)) {
            p.cancel("Cancelled.");
            process.exit(0);
        }
        customPrompt = promptInput as string;
    }

    // Provider/model selection
    let providerName = opts.provider;
    let modelName = opts.model;
    if (!providerName && !modelName) {
        p.log.step("Select LLM provider and model:");
        const choice = await modelSelector.selectModel();
        if (!choice) {
            p.cancel("Model selection cancelled.");
            process.exit(0);
        }
        providerName = choice.provider.name;
        modelName = choice.model.id;
    }

    // Token budget
    const tokenBudget = opts.maxTokens ? parseInt(opts.maxTokens, 10) : 128_000;

    // Preview: estimate content size and cost
    const prepared = session.toPromptContent({
        tokenBudget,
        priority: (opts.priority as "balanced" | "user-first" | "assistant-first") ?? "balanced",
        includeToolResults: opts.includeToolResults,
        includeThinking: opts.includeThinking,
    });

    const sessionTitle = session.title ?? session.summary ?? "(unnamed session)";
    const sessionDate = session.startDate?.toISOString().split("T")[0] ?? "unknown";

    p.note(
        [
            `Session:  ${sessionTitle}`,
            `Date:     ${sessionDate}`,
            `Branch:   ${session.gitBranch ?? "n/a"}`,
            `Mode:     ${mode}`,
            `Model:    ${providerName}/${modelName}`,
            `Content:  ~${prepared.tokenCount.toLocaleString()} tokens`,
            `Truncated: ${prepared.truncated ? "yes" : "no"}`,
            opts.thorough ? `Chunked:  yes` : "",
        ]
            .filter(Boolean)
            .join("\n"),
        "Summary Preview"
    );

    // Confirm
    if (!opts.promptOnly) {
        const confirmed = await p.confirm({
            message: "Proceed with summarization?",
        });
        if (p.isCancel(confirmed) || !confirmed) {
            p.cancel("Cancelled.");
            process.exit(0);
        }
    }

    // Apple Notes folder picker
    let appleNotesFolderId: string | undefined;
    if (opts.appleNotes) {
        appleNotesFolderId = await pickAppleNotesFolder();
    }

    return {
        session,
        mode,
        customPrompt,
        provider: providerName,
        model: modelName,
        streaming: true,
        promptOnly: opts.promptOnly,
        tokenBudget,
        includeToolResults: opts.includeToolResults,
        includeThinking: opts.includeThinking,
        priority: (opts.priority as "balanced" | "user-first" | "assistant-first") ?? "balanced",
        thorough: opts.thorough,
        outputPath: opts.output,
        clipboard: opts.clipboard,
        memoryDir: opts.memoryDir,
        appleNotes: opts.appleNotes,
        appleNotesFolderId,
    };
}

// =============================================================================
// Non-Interactive Flow
// =============================================================================

function buildNonInteractiveOptions(session: ClaudeSession, opts: SummarizeCommandOptions): SummarizeOptions {
    const mode = opts.mode ?? "documentation";
    const tokenBudget = opts.maxTokens ? parseInt(opts.maxTokens, 10) : 128_000;

    if (mode === "custom" && !opts.customPrompt) {
        throw new Error(
            "Custom mode requires --custom-prompt. Provide a prompt string or use -i for interactive mode."
        );
    }

    return {
        session,
        mode,
        customPrompt: opts.customPrompt,
        provider: opts.provider,
        model: opts.model,
        streaming: process.stdout.isTTY,
        promptOnly: opts.promptOnly,
        tokenBudget,
        includeToolResults: opts.includeToolResults,
        includeThinking: opts.includeThinking,
        priority: (opts.priority as "balanced" | "user-first" | "assistant-first") ?? "balanced",
        thorough: opts.thorough,
        outputPath: opts.output,
        clipboard: opts.clipboard,
        memoryDir: opts.memoryDir,
        appleNotes: opts.appleNotes,
    };
}

// =============================================================================
// Result Display
// =============================================================================

function displayResult(result: SummarizeResult): void {
    if (!process.stdout.isTTY) return;

    const parts: string[] = ["\n"];

    if (result.tokenUsage) {
        parts.push(
            chalk.dim(
                `Tokens: ${result.tokenUsage.input.toLocaleString()} in / ${result.tokenUsage.output.toLocaleString()} out`
            )
        );
    }

    if (result.cost !== undefined && result.cost > 0) {
        parts.push(chalk.dim(`Cost: ${dynamicPricingManager.formatCost(result.cost)}`));
    }

    if (result.outputPaths.length > 0) {
        parts.push(chalk.green(`Written to: ${result.outputPaths.join(", ")}`));
    }

    if (result.truncated && result.truncationInfo) {
        parts.push(chalk.yellow(`Note: ${result.truncationInfo}`));
    }

    console.error(parts.join("\n"));
}

// =============================================================================
// Command Registration
// =============================================================================

export function registerSummarizeCommand(program: Command): void {
    program
        .command("summarize [session-id]")
        .description("Summarize a Claude Code session using LLM-powered templates")
        .option(
            "-s, --session <id>",
            "Session ID (repeatable)",
            (val: string, prev: string[]) => {
                prev.push(val);
                return prev;
            },
            [] as string[]
        )
        .option("--current", "Use current session ($CLAUDE_CODE_SESSION_ID)")
        .option("--since <date>", "Sessions since date")
        .option("--until <date>", "Sessions until date")
        .option("-m, --mode <name>", "Template mode (default: documentation)")
        .option("--model <name>", "LLM model")
        .option("--provider <name>", "LLM provider")
        .option("--prompt-only", "Output prompt without calling LLM")
        .option("-o, --output <path>", "Write to file")
        .option("--clipboard", "Copy to clipboard")
        .option("--thorough", "Chunked summarization for large sessions")
        .option("--max-tokens <n>", "Token budget (default: 128000)")
        .option("--include-tool-results", "Include tool results in extraction")
        .option("--include-thinking", "Include thinking blocks")
        .option("--priority <type>", "balanced|user-first|assistant-first (default: balanced)")
        .option("-i, --interactive", "Interactive flow with prompts")
        .option("--custom-prompt <text>", "Custom prompt text (for custom mode)")
        .option("--memory-dir <path>", "Output dir for memorization topic files")
        .option("--apple-notes", "Save to Apple Notes (interactive folder picker)")
        .action(async (sessionId: string | undefined, cmdOpts: SummarizeCommandOptions) => {
            try {
                const sessions = await resolveSessionIds(sessionId, cmdOpts);
                const isInteractive =
                    cmdOpts.interactive ||
                    (process.stdout.isTTY &&
                        !sessionId &&
                        !cmdOpts.session?.length &&
                        !cmdOpts.current &&
                        !cmdOpts.since);

                for (const session of sessions) {
                    let engineOptions: SummarizeOptions;

                    if (isInteractive && sessions.length === 1) {
                        engineOptions = await runInteractiveFlow(session, cmdOpts);
                    } else {
                        engineOptions = buildNonInteractiveOptions(session, cmdOpts);
                    }

                    // Apple Notes always needs the folder picker (even in non-interactive mode)
                    if (cmdOpts.appleNotes && !engineOptions.appleNotesFolderId) {
                        engineOptions.appleNotesFolderId = await pickAppleNotesFolder();
                    }

                    const engine = new SummarizeEngine(engineOptions);
                    const result = await engine.run();
                    displayResult(result);

                    // Separator between multiple sessions
                    if (sessions.length > 1) {
                        if (process.stdout.isTTY) {
                            console.error(chalk.dim("\n---\n"));
                        }
                    }
                }
            } catch (error) {
                if (error instanceof Error && error.message.includes("cancelled")) {
                    if (process.stdout.isTTY) {
                        console.error(chalk.dim("\nOperation cancelled."));
                    }
                    process.exit(0);
                }
                console.error(chalk.red(`Error: ${error instanceof Error ? error.message : String(error)}`));
                process.exit(1);
            }
        });
}
