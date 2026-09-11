import { mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { extractShellQuirks, renderShellQuirksMarkdown } from "@app/claude/lib/history/extract-shell-quirks";
import { getAvailableProjects } from "@app/claude/lib/history/search";
import { type HistoryCliOptions, registerAgentHistoryCommand } from "@genesiscz/utils/agent-sessions/history-cli";
import { createClaudeAdapter } from "@genesiscz/utils/agent-sessions/native-adapter";
import type { AgentSearchHit } from "@genesiscz/utils/agent-sessions/types";
import { resolveProjectFilter } from "@genesiscz/utils/claude";
import { isInteractive } from "@genesiscz/utils/cli";
import { buildViteDevCmd, defineDashboardApp } from "@genesiscz/utils/DashboardApp";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import { PROJECT_ROOT } from "@genesiscz/utils/paths";
import { profiler } from "@genesiscz/utils/profile";
import * as p from "@genesiscz/utils/prompts/p";
import { spawn } from "bun";
import type { Command } from "commander";
import pc from "picocolors";

/**
 * `tools claude history`, over the shared command.
 *
 * This file used to be a second implementation of `registerAgentHistoryCommand`: the same
 * twenty-seven flags declared by hand, plus its own markdown, table and JSON renderers. Those
 * renderers were the RICHER ones, so they moved into the shared module first (d8bc00388) and
 * every door gained them. What is left here is what is genuinely Claude's — the project
 * auto-detect, the filter wizard, the offer to summarize, and two subcommands.
 */

// =============================================================================
// Interactive Mode
// =============================================================================

async function runInteractive(): Promise<HistoryCliOptions> {
    const projects = await getAvailableProjects();

    const project = await p.search<string>({
        message: "Select project (type to filter):",
        options: async (term) => {
            const filtered = term
                ? projects.filter((proj) => proj.toLowerCase().includes(term.toLowerCase()))
                : projects;
            return [{ value: "all", label: "All projects" }, ...filtered.map((proj) => ({ value: proj, label: proj }))];
        },
    });

    const query = (await p.text({
        message: "Search query (leave empty for all):",
    })) as string;

    const toolChoice = (await p.select({
        message: "Filter by tool?",
        options: [
            { value: "", label: "No filter" },
            { value: "Edit", label: "Edit" },
            { value: "Write", label: "Write" },
            { value: "Read", label: "Read" },
            { value: "Bash", label: "Bash" },
            { value: "Task", label: "Task" },
            { value: "Grep", label: "Grep" },
            { value: "Glob", label: "Glob" },
        ],
    })) as string;

    const sinceStr = (await p.text({
        message: "Since (e.g., '7 days ago', 'yesterday', or date):",
        initialValue: "",
    })) as string;

    const contextStr = (await p.text({
        message: "Context lines (0 for summary only):",
        initialValue: "0",
    })) as string;

    return {
        ...(project === "all" ? { all: true } : { project }),
        ...(query ? { query } : {}),
        ...(toolChoice ? { tool: toolChoice } : {}),
        ...(sinceStr ? { since: sinceStr } : {}),
        // A free-text field reaches a parser that refuses anything but a non-negative integer,
        // and refuses it by throwing. A typo in a prompt should not end the command.
        context: /^\d+$/.test(contextStr.trim()) ? contextStr.trim() : "0",
        limit: "20",
    };
}

// =============================================================================
// Command Registration
// =============================================================================

/**
 * `-i` ends with the results on screen and one obvious next step.
 *
 * `isInteractive()` rather than a TTY check: it also accounts for CI, a pipe and a headless
 * run, none of which can answer a prompt.
 */
async function offerToSummarize(hits: AgentSearchHit<string>[], options: HistoryCliOptions): Promise<void> {
    if (!options.interactive || hits.length === 0 || !isInteractive()) {
        return;
    }

    const wanted = await out.confirm({
        message: "Would you like to summarize one of these sessions?",
        initialValue: false,
    });

    if (out.isCancel(wanted) || !wanted) {
        return;
    }

    const chosen = await out.select({
        message: "Select session to summarize:",
        options: hits.map((hit) => ({
            value: hit.sessionId,
            label: `${hit.title} (${hit.mtime.toISOString().slice(0, 10)})`,
        })),
    });

    if (out.isCancel(chosen)) {
        return;
    }

    const proc = spawn({
        cmd: ["bun", "run", resolve(import.meta.dir, "../index.ts"), "summarize", chosen as string, "-i"],
        stdio: ["inherit", "inherit", "inherit"],
    });
    await proc.exited;
}

// =============================================================================
// Command Registration
// =============================================================================

export function registerHistoryCommand(program: Command): void {
    const historyCmd = registerAgentHistoryCommand(program, createClaudeAdapter(), "claude", {
        defaultScope: () => {
            // A search run from a SUBdirectory of a project still means that project. The
            // shared default is an exact cwd, which would match none of its sessions.
            const project = resolveProjectFilter();

            if (!project) {
                return undefined;
            }

            // An encoded transcript directory ("-Users-Martin-Projects-Foo") reads as noise.
            const shown = project.startsWith("-") ? basename(process.cwd()) : project;

            return { project, notice: `Auto-detected project: ${shown} (use --all to search all projects)` };
        },
        interactiveFilters: runInteractive,
        afterResults: offerToSummarize,
    });

    // -------------------------------------------------------------------------
    // extract-shell-quirks — mine zsh/bash NOMATCH failures from session JSONLs
    // -------------------------------------------------------------------------
    historyCmd
        .command("extract-shell-quirks")
        .description(
            "Extract zsh/bash shell-quirk incidents (NOMATCH, unquoted URLs/globs, *(N) fails) from session JSONLs"
        )
        .option("-p, --project <name>", "Filter by project name / encoded dir")
        .option("--all", "Scan all projects (default when no --project)")
        .option("--exclude-agents", "Skip subagent transcripts")
        .option("--no-rule-codification", "Skip pure discussion / CLAUDE.md rule-writing hits")
        .option("--no-dedupe", "Keep every repeated occurrence as its own finding (default collapses to ×N)")
        // Use --max (not -l): parent `history` already owns -l/--limit
        .option("--max <n>", "Max findings to keep (scan may stop early)")
        .option("--excerpt <n>", "Max chars per command/result excerpt", "1200")
        .option("-o, --output <path>", "Write markdown report to this path")
        .option("--json", "Machine-readable findings JSON on stdout")
        .option("--md", "Print markdown to stdout (default when no --output/--json)")
        .action(
            async (
                options: {
                    project?: string;
                    all?: boolean;
                    excludeAgents?: boolean;
                    ruleCodification?: boolean;
                    dedupe?: boolean;
                    max?: string;
                    excerpt: string;
                    output?: string;
                    json?: boolean;
                    md?: boolean;
                },
                cmd: Command
            ) => {
                // The parent `history` command also declares `-p, --project`, and commander
                // binds a shared flag to the PARENT: without this fallback the subcommand
                // never saw --project and silently scanned every project.
                const parentOpts = cmd.parent?.opts<{ project?: string; all?: boolean }>();
                const project = options.project ?? parentOpts?.project;
                const scanAll = options.all ?? parentOpts?.all;
                // Progress narration goes to stderr: stdout carries the machine result, and
                // `--json` piped into a parser used to arrive wrapped in human text.
                out.printlnErr(pc.dim("Scanning Claude session JSONLs for zsh/bash shell quirks…"));

                const maxFindings = options.max ? parseInt(options.max, 10) : undefined;
                const result = await profiler.scope("claude-history").measureAsync("history.extract-shell-quirks", () =>
                    extractShellQuirks({
                        project: scanAll ? undefined : project,
                        includeSubagents: !options.excludeAgents,
                        includeRuleCodification: options.ruleCodification !== false,
                        dedupe: options.dedupe !== false,
                        limit: maxFindings && maxFindings > 0 ? maxFindings : undefined,
                        excerptChars: parseInt(options.excerpt, 10) || 1200,
                        onProgress: (done, total, file) => {
                            if (done === total || done % 25 === 0) {
                                out.printlnErr(pc.dim(`  ${done}/${total}  ${basename(file)}`));
                            }
                        },
                    })
                );

                out.printlnErr(
                    pc.green(
                        `Done: ${result.findings.length} findings in ${result.filesWithHits}/${result.filesScanned} files (${result.elapsedMs} ms)`
                    )
                );

                if (options.json) {
                    out.result(
                        SafeJSON.stringify(
                            {
                                meta: {
                                    filesScanned: result.filesScanned,
                                    filesWithHits: result.filesWithHits,
                                    candidateFiles: result.candidateFiles,
                                    elapsedMs: result.elapsedMs,
                                },
                                findings: result.findings,
                            },
                            { strict: true }
                        )
                    );
                    return;
                }

                const md = renderShellQuirksMarkdown(result, {
                    generatedAt: new Date().toISOString(),
                    command: "tools claude history extract-shell-quirks",
                    claudeMdNote:
                        "Source rules: `~/.claude/CLAUDE.md` section **zsh quirks** (shell is zsh 5.9, not bash).",
                });

                if (options.output) {
                    mkdirSync(dirname(options.output), { recursive: true });
                    writeFileSync(options.output, md, "utf8");
                    out.printlnErr(pc.cyan(`Wrote ${options.output}`));
                    return;
                }

                // default: markdown to stdout
                out.print(md);
            }
        );

    const dashboardDir = resolve(import.meta.dir, "../../claude-history-dashboard");
    const viteConfigPath = resolve(dashboardDir, "vite.config.ts");

    const claudeHistoryApp = defineDashboardApp({
        type: "ui",
        key: "claude-history",
        name: "Claude History Browser",
        description: "Search & browse Claude Code conversation history",
        commandName: "dashboard",
        spawn: {
            cmd: buildViteDevCmd({ configPath: viteConfigPath, strictPort: true }),
            cwd: PROJECT_ROOT,
        },
        readiness: { kind: "http", path: "/" },
        openBrowser: { enabled: true },
        launchd: { available: true },
    });

    historyCmd.addCommand(claudeHistoryApp.commanderCommand);
}
