// Code search command implementation

import { Command } from "commander";
import chalk from "chalk";
import { getOctokit } from "@app/utils/github/octokit";
import { withRetry } from "@app/utils/github/rate-limit";
import { verbose, setGlobalVerbose } from "@app/utils/github/utils";
import logger from "@app/logger";

interface CodeSearchOptions {
    repo?: string;
    path?: string;
    language?: string;
    limit?: number;
    format?: string;
    output?: string;
    verbose?: boolean;
}

interface CodeSearchResult {
    path: string;
    repo: string;
    url: string;
    score: number;
    fragment?: string;
}

/**
 * Search code in GitHub repositories
 */
async function searchCode(query: string, options: CodeSearchOptions): Promise<CodeSearchResult[]> {
    const octokit = getOctokit();

    // Build search query
    let searchQuery = query;

    if (options.repo) {
        searchQuery += ` repo:${options.repo}`;
    }

    if (options.path) {
        searchQuery += ` path:${options.path}`;
    }

    if (options.language) {
        searchQuery += ` language:${options.language}`;
    }

    console.log(chalk.dim(`Searching code: ${searchQuery}`));

    const { data } = await withRetry(
        () =>
            octokit.rest.search.code({
                q: searchQuery,
                per_page: options.limit || 30,
                headers: {
                    accept: "application/vnd.github.text-match+json",
                },
            }),
        { label: `GET /search/code?q=${encodeURIComponent(searchQuery.slice(0, 50))}...` }
    );

    return data.items.map((item) => ({
        path: item.path,
        repo: item.repository.full_name,
        url: item.html_url,
        score: item.score,
        fragment: (item as { text_matches?: Array<{ fragment?: string }> }).text_matches?.[0]?.fragment,
    }));
}

function formatCodeResults(results: CodeSearchResult[], format: string): string {
    if (format === "json") {
        return JSON.stringify(results, null, 2);
    }

    // Default markdown/AI format
    const lines = [`# Code Search Results (${results.length})\n`];

    for (const result of results) {
        lines.push(`## [${result.path}](${result.url})`);
        lines.push(`**Repo:** ${result.repo}`);
        if (result.fragment) {
            lines.push("```");
            lines.push(result.fragment);
            lines.push("```");
        }
        lines.push("");
    }

    return lines.join("\n");
}

export async function codeSearchCommand(query: string, options: CodeSearchOptions): Promise<void> {
    if (options.verbose) {
        setGlobalVerbose(true);
    }

    verbose(options, `Code search query: ${query}`);

    const results = await searchCode(query, options);
    verbose(options, `Found ${results.length} results`);

    if (results.length === 0) {
        console.log(chalk.yellow("No code results found."));
        return;
    }

    const format = options.format || "ai";
    const output = formatCodeResults(results, format);

    if (options.output) {
        await Bun.write(options.output, output);
        console.log(chalk.green(`✔ Output written to ${options.output}`));
    } else {
        console.log(output);
    }
}

export function createCodeSearchCommand(): Command {
    const cmd = new Command("code")
        .description("Search code in GitHub repositories")
        .argument("<query>", "Search query (code content)")
        .option("-r, --repo <owner/repo>", "Limit to repository (recommended)")
        .option("-p, --path <path>", 'Filter by file path (e.g., "src/**/*.ts")')
        .option("-l, --language <lang>", "Filter by language (e.g., typescript, python)")
        .option("-L, --limit <n>", "Max results", parseInt, 30)
        .option("-f, --format <format>", "Output format: ai|md|json", "ai")
        .option("-o, --output <file>", "Output path")
        .option("-v, --verbose", "Enable verbose logging")
        .action(async (query, opts) => {
            try {
                await codeSearchCommand(query, opts);
            } catch (error) {
                logger.error({ error }, "Code search command failed");

                const errorMessage = error instanceof Error ? error.message : String(error);

                // Provide helpful tips on common errors
                if (errorMessage.includes("at least one search term")) {
                    console.error(chalk.yellow("\n📝 GitHub Code Search Tips:"));
                    console.error(chalk.dim("  • Provide a search term in your query"));
                    console.error(chalk.dim('  • Example: tools github code "useState" --repo facebook/react'));
                    console.error(chalk.dim("  • Qualifiers alone (like path:) are not sufficient"));
                    console.error("");
                }

                console.error(chalk.red(`Error: ${errorMessage}`));
                process.exit(1);
            }
        });

    return cmd;
}
