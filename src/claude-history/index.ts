#!/usr/bin/env bun
import { program } from "commander";
import { search, select, input } from "@inquirer/prompts";
import { homedir } from "os";
import chalk from "chalk";
import { spawn } from "bun";
import { resolve, sep } from "path";
import {
    searchConversations,
    listConversationSummaries,
    getAvailableProjects,
    parseDate,
    type SearchFilters,
    type SearchResult,
    type ConversationMessage,
    type AssistantMessage,
    type UserMessage,
    type TextBlock,
    type ToolUseBlock,
} from "./lib";

// =============================================================================
// Output Formatting
// =============================================================================

function formatMessageForMarkdown(msg: ConversationMessage, _excludeThinking: boolean): string {
    const lines: string[] = [];

    if (msg.type === "user") {
        const userMsg = msg as UserMessage;
        let content = "";
        if (typeof userMsg.message.content === "string") {
            content = userMsg.message.content;
        } else if (Array.isArray(userMsg.message.content)) {
            const textBlocks = userMsg.message.content
                .filter((b): b is TextBlock => b.type === "text")
                .map((b) => b.text);
            content = textBlocks.join("\n");
        }
        // Truncate long content
        if (content.length > 500) {
            content = content.substring(0, 500) + "...";
        }
        lines.push(`**[User]** ${content.replace(/\n/g, " ").trim()}`);
    } else if (msg.type === "assistant") {
        const assistantMsg = msg as AssistantMessage;
        const textBlocks = assistantMsg.message.content
            .filter((b): b is TextBlock => b.type === "text")
            .map((b) => b.text);
        const toolUses = assistantMsg.message.content.filter((b): b is ToolUseBlock => b.type === "tool_use");

        let text = textBlocks.join("\n").trim();
        if (text.length > 500) {
            text = text.substring(0, 500) + "...";
        }

        lines.push(`**[Assistant]** ${text.replace(/\n/g, " ").trim() || "(tool calls only)"}`);

        if (toolUses.length > 0) {
            for (const tool of toolUses) {
                const filePath =
                    tool.input && typeof tool.input === "object"
                        ? (tool.input as Record<string, unknown>).file_path ||
                          (tool.input as Record<string, unknown>).path ||
                          ""
                        : "";
                if (filePath) {
                    lines.push(`  - **Tool:** ${tool.name} \`${filePath}\``);
                } else {
                    lines.push(`  - **Tool:** ${tool.name}`);
                }
            }
        }
    }

    return lines.join("\n");
}

function formatResultsAsMarkdown(results: SearchResult[], filters: SearchFilters): string {
    const lines: string[] = [];

    const queryDesc = filters.query ? `"${filters.query}"` : "all";
    const modeDesc = filters.summaryOnly ? " (summary-only)" : filters.sortByRelevance ? " (by relevance)" : "";
    lines.push(
        `## Found ${results.length} conversation${results.length !== 1 ? "s" : ""} matching ${queryDesc}${modeDesc}\n`
    );

    for (let i = 0; i < results.length; i++) {
        const result = results[i];
        const title = result.customTitle || result.summary || result.sessionId;
        const date = result.timestamp.toISOString().split("T")[0];

        // Show relevance score if sorting by relevance
        const relevanceStr =
            filters.sortByRelevance && result.relevanceScore !== undefined ? ` [score: ${result.relevanceScore}]` : "";

        lines.push(
            `### ${i + 1}. ${title} (${result.project})${result.isSubagent ? " [Subagent]" : ""}${relevanceStr}`
        );
        lines.push(`**Date:** ${date}${result.gitBranch ? ` | **Branch:** ${result.gitBranch}` : ""}`);
        lines.push(`**Session ID:** \`${result.sessionId}\``);

        if (result.summary && result.summary !== title) {
            lines.push(`**Summary:** ${result.summary}`);
        }

        // Show commit hashes if found
        if (result.commitHashes && result.commitHashes.length > 0) {
            lines.push(
                `**Commits:** ${result.commitHashes
                    .slice(0, 5)
                    .map((h) => `\`${h.substring(0, 7)}\``)
                    .join(", ")}${result.commitHashes.length > 5 ? "..." : ""}`
            );
        }

        lines.push(`**File:** \`${result.filePath.replace(homedir(), "~")}\``);

        // Show context if requested
        if (filters.context && result.contextMessages) {
            lines.push("");
            lines.push(`#### Context (${filters.context} messages before/after match)\n`);
            for (const msg of result.contextMessages) {
                const formatted = formatMessageForMarkdown(msg, !!filters.excludeThinking);
                if (formatted) {
                    lines.push(formatted);
                    lines.push("");
                }
            }
        }

        lines.push("");
    }

    return lines.join("\n");
}

function formatResultsAsJson(results: SearchResult[]): string {
    return JSON.stringify(results, null, 2);
}

// =============================================================================
// Interactive Mode
// =============================================================================

async function runInteractive(): Promise<SearchFilters> {
    const projects = await getAvailableProjects();

    const project = await search({
        message: "Select project (type to filter):",
        source: async (term) => {
            const filtered = term ? projects.filter((p) => p.toLowerCase().includes(term.toLowerCase())) : projects;
            return [{ value: "all", name: "All projects" }, ...filtered.map((p) => ({ value: p, name: p }))];
        },
    });

    const query = await input({
        message: "Search query (leave empty for all):",
    });

    const toolChoice = await select({
        message: "Filter by tool?",
        choices: [
            { value: "", name: "No filter" },
            { value: "Edit", name: "Edit" },
            { value: "Write", name: "Write" },
            { value: "Read", name: "Read" },
            { value: "Bash", name: "Bash" },
            { value: "Task", name: "Task" },
            { value: "Grep", name: "Grep" },
            { value: "Glob", name: "Glob" },
        ],
    });

    const sinceStr = await input({
        message: "Since (e.g., '7 days ago', 'yesterday', or date):",
        default: "",
    });

    const contextStr = await input({
        message: "Context lines (0 for summary only):",
        default: "0",
    });

    return {
        project: project === "all" ? undefined : project,
        query: query || undefined,
        tool: toolChoice || undefined,
        since: sinceStr ? parseDate(sinceStr) : undefined,
        context: parseInt(contextStr, 10) || undefined,
        limit: 20,
    };
}

// =============================================================================
// CLI Setup
// =============================================================================

program.name("claude-history").description("Search Claude Code conversation history");

// Default search command
program
    .argument("[query]", "Search query (fuzzy match by default)")
    .option("-i, --interactive", "Interactive mode with prompts")
    .option("-p, --project <name>", "Filter by project name")
    .option("--all", "Search all projects (ignore cwd)")
    .option("-f, --file <pattern>", "Filter by file path pattern")
    .option("-t, --tool <name>", "Filter by tool name (Edit, Write, Bash, etc.)")
    .option("--since <date>", "Filter by date (e.g., '7 days ago', 'yesterday')")
    .option("--until <date>", "Filter until date")
    .option("-l, --limit <n>", "Limit results", "20")
    .option("-c, --context <n>", "Show N messages before/after match", "0")
    .option("--exact", "Exact match instead of fuzzy")
    .option("--regex", "Use regex for query")
    .option("--agents-only", "Only search subagent conversations")
    .option("--exclude-agents", "Exclude subagent conversations")
    .option("--exclude-thinking", "Exclude thinking blocks from search")
    .option("--format <type>", "Output format: ai (default), json", "ai")
    .option("--summary-only", "Search only conversation titles/summaries (faster)")
    .option("--exclude-current", "Exclude current session (uses $CLAUDE_CODE_SESSION_ID)")
    .option("--exclude-session <id>", "Exclude specific session ID from results")
    .option("--sort-relevance", "Sort results by relevance score instead of date")
    .option("--commit <hash>", "Find conversation that made a specific git commit")
    .option("--commit-msg <text>", "Find conversation by commit message content")
    .option("--conv-date <date>", "Filter by conversation start date (not message date)")
    .option("--conv-date-until <date>", "Filter conversation start date until")
    .option("--list-summaries", "Quick list of conversation topics (no content search)")
    .action(async (query, options) => {
        try {
            let filters: SearchFilters;

            if (options.interactive) {
                filters = await runInteractive();
            } else {
                // Auto-detect project from cwd
                let project = options.project;
                if (!project && !options.all) {
                    const cwd = process.cwd();
                    const cwdParts = cwd.split(sep);
                    // Try to find project name from cwd
                    const projectIndex = cwdParts.findIndex((p) => p === "Projects" || p === "projects");
                    if (projectIndex !== -1 && cwdParts[projectIndex + 1]) {
                        project = cwdParts[projectIndex + 1];
                        console.log(chalk.dim(`Auto-detected project: ${project} (use --all to search all projects)`));
                    }
                }

                // Get session ID to exclude (explicit or from env)
                const currentSessionId =
                    options.excludeSession || (options.excludeCurrent ? process.env.CLAUDE_CODE_SESSION_ID : undefined);

                filters = {
                    query,
                    project: options.all ? undefined : project,
                    file: options.file,
                    tool: options.tool,
                    since: options.since ? parseDate(options.since) : undefined,
                    until: options.until ? parseDate(options.until) : undefined,
                    limit: parseInt(options.limit, 10),
                    context: parseInt(options.context, 10),
                    exact: options.exact,
                    regex: options.regex,
                    agentsOnly: options.agentsOnly,
                    excludeAgents: options.excludeAgents,
                    excludeThinking: options.excludeThinking,
                    summaryOnly: options.summaryOnly,
                    excludeCurrentSession: currentSessionId,
                    sortByRelevance: options.sortRelevance,
                    commitHash: options.commit,
                    commitMessage: options.commitMsg,
                    conversationDate: options.convDate ? parseDate(options.convDate) : undefined,
                    conversationDateUntil: options.convDateUntil ? parseDate(options.convDateUntil) : undefined,
                };
            }

            // Use listConversationSummaries for --list-summaries mode
            const results = options.listSummaries
                ? await listConversationSummaries(filters)
                : await searchConversations(filters);

            if (results.length === 0) {
                console.log(chalk.yellow("No conversations found matching your criteria."));
                return;
            }

            if (options.format === "json") {
                console.log(formatResultsAsJson(results));
            } else {
                console.log(formatResultsAsMarkdown(results, filters));
            }
        } catch (error) {
            if ((error as Error).message?.includes("canceled")) {
                console.log(chalk.dim("\nOperation cancelled."));
                process.exit(0);
            }
            throw error;
        }
    });

// Dashboard command
program
    .command("dashboard")
    .description("Launch the web-based dashboard for browsing conversation history")
    .option("-p, --port <port>", "Port to run the dashboard on", "3069")
    .action(async (options) => {
        const dashboardDir = resolve(import.meta.dir, "../claude-history-dashboard");
        console.log(chalk.cyan("🚀 Starting Claude History Dashboard..."));
        console.log(chalk.dim(`   Directory: ${dashboardDir}`));
        console.log(chalk.dim(`   Port: ${options.port}`));
        console.log();

        const proc = spawn({
            cmd: ["bun", "run", "dev", "--port", options.port],
            cwd: dashboardDir,
            stdio: ["inherit", "inherit", "inherit"],
        });

        await proc.exited;
    });

program.parse();
