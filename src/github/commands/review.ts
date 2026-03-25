// Review command - fetch, display, reply to, and resolve PR review threads

import {
    formatPrCommentsLLM,
    formatReviewJSON,
    formatReviewLLM,
    formatReviewMarkdown,
    formatReviewTerminal,
    formatThreadExpanded,
    saveReviewMarkdown,
} from "@app/github/lib/review-output";
import { ReviewSessionManager } from "@app/github/lib/review-session";
import {
    batchReply,
    batchReplyAndResolve,
    batchResolveThreads,
    calculateReviewStats,
    fetchPRReviewThreads,
    parseThreads,
} from "@app/github/lib/review-threads";
import type { ReviewCommandOptions, ReviewData, ReviewSessionData } from "@app/github/types";
import logger from "@app/logger";
import { formatRelativeTime } from "@app/utils/format";
import { detectRepoFromGit, parseGitHubUrl } from "@app/utils/github/url-parser";
import { setGlobalVerbose } from "@app/utils/github/utils";
import chalk from "chalk";
import { Command } from "commander";

/**
 * Main review command handler
 */
export async function reviewCommand(input: string, options: ReviewCommandOptions): Promise<void> {
    // Set global verbose for HTTP request logging
    if (options.verbose) {
        setGlobalVerbose(true);
    }

    // Parse input
    const defaultRepo = options.repo || (await detectRepoFromGit()) || undefined;
    const parsed = parseGitHubUrl(input, defaultRepo);

    if (!parsed) {
        throw new Error("Invalid input. Please provide a GitHub PR URL or number.");
    }

    const { owner, repo, number: prNumber } = parsed;

    // Validate thread-id is provided when respond or resolve operations are requested
    const resolveThreadOpt = options.resolveThread || options.resolve;
    if ((options.respond || resolveThreadOpt) && !options.threadId) {
        throw new Error(
            "--thread-id is required when using --respond or --resolve-thread\n" +
                'Usage: tools github review <pr> --respond "message" -t <thread-id>\n' +
                "       tools github review <pr> --resolve-thread -t <thread-id>"
        );
    }

    // Handle respond and/or resolve operations (supports comma-separated thread IDs)
    if ((options.respond || resolveThreadOpt) && options.threadId) {
        const threadIds = options.threadId
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
        if (threadIds.length === 0) {
            throw new Error("No valid thread IDs provided. Check your --thread-id value.");
        }
        const showProgress = threadIds.length > 1;

        if (options.respond && resolveThreadOpt) {
            const result = await batchReplyAndResolve(threadIds, options.respond, {
                onProgress: showProgress
                    ? (done, total) => console.error(chalk.dim(`  [${done}/${total}]`))
                    : undefined,
            });
            if (result.replied === 0 && result.failed.length > 0) {
                throw new Error(
                    `Failed to reply to or resolve any of ${result.failed.length} thread(s): ${result.failed.join(", ")}`
                );
            }
            console.log(chalk.green(`Replied to ${result.replied}, resolved ${result.resolved} thread(s)`));
            if (result.failed.length) {
                console.error(chalk.red(`Failed: ${result.failed.join(", ")}`));
            }
        } else if (resolveThreadOpt) {
            const result = await batchResolveThreads(threadIds, {
                onProgress: showProgress
                    ? (done, total) => console.error(chalk.dim(`  [${done}/${total}]`))
                    : undefined,
            });
            if (result.resolved === 0 && result.failed.length > 0) {
                throw new Error(
                    `Failed to resolve any of ${result.failed.length} thread(s): ${result.failed.join(", ")}`
                );
            }
            console.log(chalk.green(`Resolved ${result.resolved} thread(s)`));
            if (result.failed.length) {
                console.error(chalk.red(`Failed: ${result.failed.join(", ")}`));
            }
        } else {
            const result = await batchReply(threadIds, options.respond ?? "", {
                onProgress: showProgress
                    ? (done, total) => console.error(chalk.dim(`  [${done}/${total}]`))
                    : undefined,
            });
            if (result.replied === 0 && result.failed.length > 0) {
                throw new Error(
                    `Failed to reply to any of ${result.failed.length} thread(s): ${result.failed.join(", ")}`
                );
            }
            console.log(chalk.green(`Replied to ${result.replied} thread(s)`));
            if (result.failed.length) {
                console.error(chalk.red(`Failed: ${result.failed.join(", ")}`));
            }
        }

        return;
    }

    // Fetch PR review threads
    if (!options.json) {
        console.error(chalk.dim(`Fetching PR #${prNumber} from ${owner}/${repo}...`));
    }

    const prInfo = await fetchPRReviewThreads(owner, repo, prNumber);

    // Parse threads, apply author filter, then compute stats
    const allThreads = parseThreads(prInfo.threads);
    const authorLogin = options.author?.toLowerCase();
    const authorFilteredThreads = authorLogin
        ? allThreads.filter((t) => t.author.toLowerCase() === authorLogin)
        : allThreads;
    const stats = calculateReviewStats(authorFilteredThreads);

    // Filter by resolution status if requested
    const displayThreads = options.unresolvedOnly
        ? authorFilteredThreads.filter((t) => t.status === "unresolved")
        : authorFilteredThreads;

    // Build review data
    const reviewData: ReviewData = {
        owner,
        repo,
        prNumber,
        title: prInfo.title,
        state: prInfo.state,
        headRefName: prInfo.headRefName,
        baseRefName: prInfo.baseRefName,
        threads: displayThreads,
        stats,
        prComments:
            options.prComments !== false
                ? authorLogin
                    ? prInfo.prComments?.filter((c) => c.author.toLowerCase() === authorLogin)
                    : prInfo.prComments
                : undefined,
    };

    // Handle worktree switching
    if (options.worktree && prInfo.headRefName) {
        const { ensureWorktreeForBranch } = await import("@app/utils/git/worktree");

        try {
            const worktreeResult = await ensureWorktreeForBranch({
                branch: prInfo.headRefName,
                basePath: typeof options.worktree === "string" ? options.worktree : undefined,
                prNumber,
            });

            if (worktreeResult.created) {
                console.error(chalk.yellow(`⚠️  Created worktree: ${worktreeResult.path}`));
            }

            if (worktreeResult.dirty) {
                console.error(chalk.yellow(`⚠️  Worktree has uncommitted changes`));
            }

            if (worktreeResult.path !== process.cwd()) {
                console.error(
                    chalk.yellow(`⚠️  Switching cwd from ${process.cwd()} to ${worktreeResult.path}`)
                );
            }

            console.log(`WORKTREE_PATH: ${worktreeResult.path}`);
        } catch (err) {
            console.error(
                chalk.red(`Worktree error: ${err instanceof Error ? err.message : String(err)}`)
            );
        }
    }

    // LLM-optimized output (session-based with refs)
    if (options.llm) {
        const sessionMgr = new ReviewSessionManager();
        const recentSession = await sessionMgr.findRecentSessionForPR(owner, repo, prNumber);
        const isFirstFetch = !recentSession;
        const sessionId = options.session || sessionMgr.generateSessionId(prNumber);

        // Reindex threads with contiguous ref numbers (t1, t2, ...) for session-local refs
        const sessionThreads = displayThreads.map((thread, index) => ({
            ...thread,
            threadNumber: index + 1,
        }));
        const sessionStats = calculateReviewStats(sessionThreads);

        const sessionData: ReviewSessionData = {
            meta: {
                sessionId,
                owner,
                repo,
                prNumber,
                title: prInfo.title,
                state: prInfo.state,
                headRefName: prInfo.headRefName,
                baseRefName: prInfo.baseRefName,
                createdAt: Date.now(),
                stats: sessionStats,
                threadCount: sessionThreads.length,
            },
            threads: sessionThreads,
            prComments: reviewData.prComments,
        };

        const llmReviewData: ReviewData = {
            ...reviewData,
            threads: sessionThreads,
            stats: sessionStats,
        };

        await sessionMgr.createSession(sessionData);

        let output = formatReviewLLM(llmReviewData, sessionId);

        const prComments = reviewData.prComments ?? [];
        if (prComments.length > 0) {
            if (isFirstFetch) {
                output += `\n${formatPrCommentsLLM(prComments, sessionId)}`;
            } else {
                output += `\nSummary: tools github review summary -s ${sessionId}\n`;
            }
        }

        console.log(output);
        return;
    }

    // JSON output
    if (options.json) {
        process.stdout.write(`${formatReviewJSON(reviewData)}\n`);
        return;
    }

    // Markdown output (save to file)
    if (options.md) {
        const mdContent = formatReviewMarkdown(reviewData, options.groupByFile ?? false);
        const filePath = await saveReviewMarkdown(mdContent, prNumber, {
            save: options.save,
            repo: `${owner}-${repo}`,
            originalCwd: process.cwd(),
        });
        console.log(filePath);
        console.error(`  View: tools markdown-cli ${filePath}`);
        return;
    }

    // Terminal output (default)
    console.log(formatReviewTerminal(reviewData, options.groupByFile ?? false));
}

async function expandCommand(refs: string, options: { session?: string; repo?: string }): Promise<void> {
    const sessionMgr = new ReviewSessionManager();
    const sessionId = options.session;
    if (!sessionId) {
        throw new Error("Session ID required. Use -s <session-id>");
    }

    const sessionData = await sessionMgr.loadSession(sessionId);
    if (!sessionData) {
        throw new Error(`Session not found or expired: ${sessionId}`);
    }

    const refIds = refs
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    const resolved = sessionMgr.resolveRefIds(sessionData, refIds);

    for (const { refId, thread } of resolved) {
        if (!thread) {
            console.error(`Warning: ref ${refId} not found in session`);
            continue;
        }

        console.log(formatThreadExpanded(thread, sessionId));
    }
}

async function respondCommand(
    refs: string,
    message: string,
    options: { session?: string; resolve?: boolean }
): Promise<void> {
    const sessionMgr = new ReviewSessionManager();
    const sessionId = options.session;
    if (!sessionId) {
        throw new Error("Session ID required. Use -s <session-id>");
    }

    const sessionData = await sessionMgr.loadSession(sessionId);
    if (!sessionData) {
        throw new Error(`Session not found or expired: ${sessionId}`);
    }

    const refIds = refs
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    const resolved = sessionMgr.resolveRefIds(sessionData, refIds);
    const missing = resolved.filter((r) => !r.thread);
    if (missing.length > 0) {
        console.error(chalk.yellow(`Warning: could not resolve ref(s): ${missing.map((r) => r.refId).join(", ")}`));
    }

    const threadIds = [...new Set(resolved.filter((r) => r.thread).map((r) => r.threadId))];

    if (threadIds.length === 0) {
        throw new Error("No valid thread refs resolved");
    }

    const showProgress = threadIds.length > 1;

    if (options.resolve) {
        const result = await batchReplyAndResolve(threadIds, message, {
            onProgress: showProgress ? (done, total) => console.error(chalk.dim(`  [${done}/${total}]`)) : undefined,
        });

        if (result.failed.length) {
            console.error(chalk.red(`Failed: ${result.failed.join(", ")}`));
        }

        if (result.replied === 0 && result.failed.length > 0) {
            throw new Error(`All thread mutations failed: ${result.failed.join(", ")}`);
        }

        console.log(chalk.green(`Replied to ${result.replied}, resolved ${result.resolved} thread(s)`));
    } else {
        const result = await batchReply(threadIds, message, {
            onProgress: showProgress ? (done, total) => console.error(chalk.dim(`  [${done}/${total}]`)) : undefined,
        });

        if (result.failed.length) {
            console.error(chalk.red(`Failed: ${result.failed.join(", ")}`));
        }

        if (result.replied === 0 && result.failed.length > 0) {
            throw new Error(`All thread mutations failed: ${result.failed.join(", ")}`);
        }

        console.log(chalk.green(`Replied to ${result.replied} thread(s)`));
    }
}

async function resolveCommand(refs: string, options: { session?: string }): Promise<void> {
    const sessionMgr = new ReviewSessionManager();
    const sessionId = options.session;
    if (!sessionId) {
        throw new Error("Session ID required. Use -s <session-id>");
    }

    const sessionData = await sessionMgr.loadSession(sessionId);
    if (!sessionData) {
        throw new Error(`Session not found or expired: ${sessionId}`);
    }

    const refIds = refs
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    const resolved = sessionMgr.resolveRefIds(sessionData, refIds);
    const missing = resolved.filter((r) => !r.thread);
    if (missing.length > 0) {
        console.error(chalk.yellow(`Warning: could not resolve ref(s): ${missing.map((r) => r.refId).join(", ")}`));
    }

    const threadIds = [...new Set(resolved.filter((r) => r.thread).map((r) => r.threadId))];

    if (threadIds.length === 0) {
        throw new Error("No valid thread refs resolved");
    }

    const showProgress = threadIds.length > 1;
    const result = await batchResolveThreads(threadIds, {
        onProgress: showProgress ? (done, total) => console.error(chalk.dim(`  [${done}/${total}]`)) : undefined,
    });

    console.log(chalk.green(`Resolved ${result.resolved} thread(s)`));
    if (result.failed.length) {
        console.error(chalk.red(`Failed: ${result.failed.join(", ")}`));
    }
}

async function sessionsCommand(): Promise<void> {
    const sessionMgr = new ReviewSessionManager();
    const sessions = await sessionMgr.listSessions();

    if (sessions.length === 0) {
        console.log("No review sessions found.");
        return;
    }

    console.log(`Review Sessions (${sessions.length}):\n`);
    for (const s of sessions) {
        const age = formatRelativeTime(new Date(s.createdAt), { compact: true });
        console.log(
            `  ${s.sessionId.padEnd(30)}  PR #${String(s.prNumber).padEnd(6)}  ${s.owner}/${s.repo}  ${String(s.threadCount).padEnd(3)} threads  ${age}`
        );
    }
}

async function summaryCommand(options: { session?: string }): Promise<void> {
    const sessionMgr = new ReviewSessionManager();
    const sessionId = options.session;
    if (!sessionId) {
        throw new Error("Session ID required. Use -s <session-id>");
    }

    const sessionData = await sessionMgr.loadSession(sessionId);
    if (!sessionData) {
        throw new Error(`Session not found or expired: ${sessionId}`);
    }

    const prComments = sessionData.prComments ?? [];
    console.log(formatPrCommentsLLM(prComments, sessionId));
}

/**
 * Create review command for commander
 */
export function createReviewCommand(): Command {
    const cmd = new Command("review")
        .enablePositionalOptions()
        .description(
            `Fetch and display GitHub PR review threads

Examples:
  $ tools github review 137                                              # Show review threads for PR #137
  $ tools github review https://github.com/owner/repo/pull/137           # Show review threads from URL
  $ tools github review 137 -u                                           # Show only unresolved threads
  $ tools github review 137 --json                                       # Output as JSON
  $ tools github review 137 --md -g                                      # Save as grouped markdown file
  $ tools github review 137 --respond "ok" -t <thread-id>                # Reply to a thread
  $ tools github review 137 --resolve-thread -t <thread-id>              # Mark a thread as resolved
  $ tools github review 137 --respond "fixed" --resolve-thread -t <thread-id>  # Reply AND resolve

  Batch operations (comma-separated thread IDs):
  $ tools github review 137 --resolve-thread -t id1,id2,id3              # Resolve multiple threads
  $ tools github review 137 --respond "Fixed" -t id1,id2                 # Reply to multiple threads
  $ tools github review 137 --respond "Fixed" --resolve-thread -t id1,id2,id3  # Reply+resolve batch

  LLM mode (session-based with refs):
  $ tools github review 137 --llm                                            # Compact L1 summary with refs
  $ tools github review 137 --llm -u -s pr137-session                        # Unresolved only, named session
  $ tools github review expand t1,t3 -s pr137-20260308-143025                # Expand threads to full detail
  $ tools github review respond t1 "Fixed in abc123" --resolve -s pr137-...  # Reply + resolve
  $ tools github review resolve t1,t2,t3 -s pr137-...                        # Resolve threads
  $ tools github review sessions                                              # List review sessions
  $ tools github review summary -s pr137-...                                  # Show PR-level review summaries`
        )
        .argument("<pr>", "PR number or full GitHub URL")
        .option("--repo <owner/repo>", "Repository (auto-detected from URL or git)")
        .option("-u, --unresolved-only", "Show only unresolved threads", false)
        .option("-g, --group-by-file", "Group threads by file path", false)
        .option("-m, --md", "Save output as markdown file to .claude/github/reviews/", false)
        .option("-j, --json", "Output as JSON", false)
        .option("-r, --respond <message>", "Reply to a thread with this message")
        .option("-t, --thread-id <ids>", "Thread ID(s) for reply/resolve (comma-separated for batch)")
        .option("-R, --resolve-thread", "Mark a thread as resolved", false)
        .option("--resolve", "Alias for --resolve-thread", false)
        .option("--llm", "LLM-optimized output with session (compact refs)", false)
        .option("-s, --session <id>", "Review session ID")
        .option("-v, --verbose", "Enable verbose logging")
        .option("--no-pr-comments", "Hide PR-level review summaries and conversation comments")
        .option("-a, --author <login>", "Filter threads by reviewer login (case-insensitive)")
        .option("-w, --worktree [path]", "Switch to/create worktree for PR branch")
        .option("--save [path]", "Save review output persistently (default: .claude/reviews/)")
        .action(async (input, opts) => {
            try {
                await reviewCommand(input, opts);
            } catch (error) {
                logger.error({ error }, "Review command failed");
                console.error(chalk.red(`Error: ${error instanceof Error ? error.message : String(error)}`));
                process.exit(1);
            }
        });

    cmd.addCommand(
        new Command("expand")
            .description("Expand thread refs to show full detail")
            .argument("<refs>", "Thread refs (comma-separated, e.g. t1,t3,t5)")
            .option("-s, --session <id>", "Review session ID")
            .option("--repo <owner/repo>", "Repository")
            .action(async (refs: string, opts: { session?: string; repo?: string }) => {
                try {
                    await expandCommand(refs, opts);
                } catch (error) {
                    console.error(chalk.red(`Error: ${error instanceof Error ? error.message : String(error)}`));
                    process.exit(1);
                }
            })
    );

    cmd.addCommand(
        new Command("respond")
            .description("Reply to review threads by ref ID")
            .argument("<refs>", "Thread refs (comma-separated, e.g. t1,t3)")
            .argument("<message>", "Reply message")
            .option("-s, --session <id>", "Review session ID")
            .option("--resolve", "Also resolve the threads after replying", false)
            .action(async (refs: string, message: string, opts: { session?: string; resolve?: boolean }) => {
                try {
                    await respondCommand(refs, message, opts);
                } catch (error) {
                    console.error(chalk.red(`Error: ${error instanceof Error ? error.message : String(error)}`));
                    process.exit(1);
                }
            })
    );

    cmd.addCommand(
        new Command("resolve")
            .description("Resolve review threads by ref ID")
            .argument("<refs>", "Thread refs (comma-separated, e.g. t1,t3,t5)")
            .option("-s, --session <id>", "Review session ID")
            .action(async (refs: string, opts: { session?: string }) => {
                try {
                    await resolveCommand(refs, opts);
                } catch (error) {
                    console.error(chalk.red(`Error: ${error instanceof Error ? error.message : String(error)}`));
                    process.exit(1);
                }
            })
    );

    cmd.addCommand(
        new Command("sessions").description("List review sessions").action(async () => {
            try {
                await sessionsCommand();
            } catch (error) {
                console.error(chalk.red(`Error: ${error instanceof Error ? error.message : String(error)}`));
                process.exit(1);
            }
        })
    );

    cmd.addCommand(
        new Command("summary")
            .description("Show PR-level review summaries (CodeRabbit walkthroughs, etc.)")
            .option("-s, --session <id>", "Review session ID")
            .action(async (opts: { session?: string }) => {
                try {
                    await summaryCommand(opts);
                } catch (error) {
                    console.error(chalk.red(`Error: ${error instanceof Error ? error.message : String(error)}`));
                    process.exit(1);
                }
            })
    );

    return cmd;
}
