// Safe PR merge command — retargets stack dependents before optional branch delete.

import { resolveMergeMethod, type SafeMergeResult, safeMergePull } from "@app/github/lib/merge";
import { logger, out } from "@app/logger";
import { detectRepoFromGit, parseGitHubUrl } from "@app/utils/github/url-parser";
import { SafeJSON } from "@app/utils/json";
import chalk from "chalk";
import { Command } from "commander";

export interface MergeCommandOptions {
    repo?: string;
    merge?: boolean;
    rebase?: boolean;
    squash?: boolean;
    deleteBranch?: boolean;
    deleteRemote?: boolean;
    subject?: string;
    body?: string;
    format?: "text" | "json";
    verbose?: boolean;
}

function formatTextSummary(result: SafeMergeResult): string {
    const lines: string[] = [];
    lines.push("");
    lines.push(chalk.green(`✔ Merged ${result.owner}/${result.repo}#${result.number} (${result.method})`));
    lines.push(`  title:  ${result.title}`);
    lines.push(`  head:   ${result.headRef}`);
    lines.push(`  base:   ${result.baseRef}`);
    lines.push(`  sha:    ${result.mergeSha || "(n/a)"}`);

    if (result.retargeted.length === 0) {
        lines.push("  dependents: none");
    } else {
        lines.push(`  dependents retargeted (${result.retargeted.length}):`);
        for (const dep of result.retargeted) {
            const mark = dep.ok ? chalk.green("✔") : chalk.red("✘");
            lines.push(`    ${mark} #${dep.number} base ${dep.fromBase} → ${dep.toBase} (${dep.state})`);
        }
    }

    if (result.branchDeleted) {
        lines.push(chalk.green(`  branch: deleted origin/${result.headRef}`));
    } else if (result.branchDeleteError) {
        lines.push(chalk.yellow(`  branch: not deleted — ${result.branchDeleteError}`));
    } else {
        lines.push(`  branch: kept origin/${result.headRef}`);
    }

    return lines.join("\n");
}

/**
 * Main merge command handler. All progress goes to stdout via out.println.
 */
export async function mergeCommand(input: string, options: MergeCommandOptions): Promise<void> {
    const method = resolveMergeMethod({
        merge: options.merge,
        rebase: options.rebase,
        squash: options.squash,
    });

    const deleteBranch = Boolean(options.deleteBranch || options.deleteRemote);
    const defaultRepo = options.repo || (await detectRepoFromGit()) || undefined;
    const parsed = parseGitHubUrl(input, defaultRepo);

    if (!parsed) {
        out.println(chalk.red("Invalid input. Provide a PR number, owner/repo#N, or full PR URL."));
        process.exitCode = 1;
        return;
    }

    const { owner, repo, number } = parsed;

    out.println(
        chalk.bold(
            `Safe merge ${owner}/${repo}#${number} (${method}${deleteBranch ? ", delete-branch after retarget" : ""})`
        )
    );

    const result = await safeMergePull({
        owner,
        repo,
        number,
        method,
        deleteBranch,
        commitTitle: options.subject,
        commitMessage: options.body,
        log: (message) => out.println(message),
    });

    if (options.format === "json") {
        out.println(
            SafeJSON.stringify(
                {
                    owner: result.owner,
                    repo: result.repo,
                    number: result.number,
                    title: result.title,
                    method: result.method,
                    headRef: result.headRef,
                    baseRef: result.baseRef,
                    mergeSha: result.mergeSha,
                    dependents: result.retargeted,
                    branchDeleted: result.branchDeleted,
                    branchDeleteError: result.branchDeleteError ?? null,
                },
                null,
                2
            )
        );
        return;
    }

    out.println(formatTextSummary(result));
}

/**
 * Create merge command.
 */
export function createMergeCommand(): Command {
    const cmd = new Command("merge")
        .description(
            "Merge a PR safely for stacks: retarget dependent PRs onto the merged base before optionally deleting the head branch (avoids GitHub CLI auto-close bug cli/cli#1168)"
        )
        .argument("<input>", "PR number, owner/repo#N, or full PR URL")
        .option("-r, --repo <owner/repo>", "Repository (auto-detected from URL or git remote)")
        .option("--merge", "Create a merge commit")
        .option("--rebase", "Rebase and merge (preserves individual commits)")
        .option("--squash", "Squash and merge")
        .option(
            "--delete-branch",
            "After retargeting dependents, delete the remote head branch (never passes delete to the merge API)"
        )
        .option("--delete-remote", "Alias for --delete-branch")
        .option("--subject <title>", "Commit title (merge/squash commit_title)")
        .option("--body <text>", "Commit message body (merge/squash commit_message)")
        .option("-f, --format <format>", "Output format: text|json", "text")
        .option("-v, --verbose", "Verbose logging (reserved)")
        .action(async (input: string, opts: MergeCommandOptions) => {
            try {
                await mergeCommand(input, opts);
            } catch (error) {
                logger.error({ error }, "Merge command failed");
                // Progress already went to stdout; final error also on stdout so
                // agent/CI logs capture the full story in one stream.
                out.println(chalk.red(`Error: ${error instanceof Error ? error.message : String(error)}`));
                process.exitCode = 1;
            }
        });

    return cmd;
}
