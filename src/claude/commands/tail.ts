import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, resolve } from "node:path";
import { ClaudeSessionFormatter } from "@app/utils/claude/ClaudeSessionFormatter";
import { ClaudeSessionTailer } from "@app/utils/claude/ClaudeSessionTailer";
import { INCLUDE_HELP, IncludeSpec } from "@app/utils/claude/cli/dsl";
import { encodedProjectDir, PROJECTS_DIR } from "@app/utils/claude/index";
import { ClaudeSession } from "@app/utils/claude/session";
import type { TailTarget } from "@app/utils/claude/session.types";
import { suggestCommand } from "@app/utils/cli/executor";
import * as p from "@clack/prompts";
import type { Command } from "commander";
import pc from "picocolors";

const STATUSLINE_DIR = resolve(homedir(), ".claude", "statusline");

interface TailOptions {
    follow: boolean;
    stopOnFinish: boolean;
    include?: string;
    interactive: boolean;
    noColors: boolean;
    raw: boolean;
    lastTurns?: string;
    lastCalls?: string;
    maxTurns?: string;
    maxCalls?: string;
    output?: string;
    outputCli: boolean;
    project?: string;
}

export function registerTailCommand(program: Command): void {
    program
        .command("tail [query]")
        .description("Live-tail a Claude session or agent")
        .option("-f, --follow", "Follow for new output (default)", true)
        .option("--no-follow", "Dump existing content and exit")
        .option("--stop-on-finish", "Exit when session/agent finishes", false)
        .option("--include <spec>", "Comma-separated content specifiers")
        .option("-i, --interactive", "Guided setup of --include via prompts", false)
        .option("--no-colors", "Disable colors")
        .option("--raw", "Raw JSONL, no formatting", false)
        .option("-t, --last-turns <n>", "Show last N turns (default: 5)")
        .option("-c, --last-calls <n>", "Show last N individual calls")
        .option("--max-turns <n>", "Stop following after N new turns")
        .option("--max-calls <n>", "Stop following after N new calls")
        .option("-o, --output <file>", "Write formatted output to file")
        .option("--output-cli", "Also print to CLI when using -o", false)
        .option("-p, --project <path>", "Search in specific project directory")
        .addHelpText("after", `\n${INCLUDE_HELP}`)
        .action(async (query: string | undefined, opts: TailOptions) => {
            const target = await resolveTarget(query, opts);

            if (!target) {
                console.error(pc.red("No matching session or agent found."));
                process.exit(1);
            }

            const includeSpec = await resolveIncludeSpec(opts);
            const isAgent = target.isAgent;
            const effectiveSpec = isAgent ? includeSpec.forAgent() : includeSpec;

            const useColors = opts.noColors ? false : (process.stdout.isTTY ?? false);
            const cliOutput = opts.output ? opts.outputCli : true;

            if (opts.output && !opts.outputCli) {
                console.log(pc.dim(`Tailing to ${opts.output}...`));
                console.log(pc.dim(suggestCommand("tools cc", { add: ["--output-cli"] })));
            }

            const formatter = new ClaudeSessionFormatter({
                includeSpec: effectiveSpec,
                colors: useColors,
                outputFile: opts.output,
                cliOutput,
                raw: opts.raw,
            });

            if (!opts.raw) {
                formatter.printBanner({
                    target,
                    includeSpec: effectiveSpec,
                    follow: opts.follow,
                    stopOnFinish: opts.stopOnFinish,
                });
            }

            const lastTurns = opts.lastCalls ? undefined : opts.lastTurns ? Number.parseInt(opts.lastTurns, 10) : 5;
            const lastCalls = opts.lastCalls ? Number.parseInt(opts.lastCalls, 10) : undefined;

            if (lastTurns === 0 || lastCalls === 0) {
                p.log.error("-t/--last-turns and -c/--last-calls must be ≥ 1 (use --no-follow to skip history)");
                process.exit(1);
            }

            const tailer = new ClaudeSessionTailer({
                filePath: target.filePath,
                onRecord: (record) => formatter.format(record),
                onFinished: () => {
                    formatter.close();

                    if (opts.output) {
                        console.log(pc.dim(`\nOutput written to ${opts.output}`));
                    }

                    process.exit(0);
                },
                includeSpec: effectiveSpec,
                lastTurns,
                lastCalls,
                maxTurns: opts.maxTurns ? Number.parseInt(opts.maxTurns, 10) : undefined,
                maxCalls: opts.maxCalls ? Number.parseInt(opts.maxCalls, 10) : undefined,
                follow: opts.follow,
                stopOnFinish: opts.stopOnFinish,
                isAgent,
            });

            process.on("SIGINT", () => {
                tailer.stop();
                formatter.close();
                console.log(pc.dim("\nStopped tailing."));
                process.exit(0);
            });

            await tailer.start();

            if (opts.follow) {
                await new Promise(() => {});
            } else {
                formatter.close();
            }
        });
}

async function resolveTarget(query: string | undefined, opts: TailOptions): Promise<TailTarget | null> {
    const projectPath = opts.project;

    if (query) {
        // Try session ID prefix first
        const sessionTarget = findSessionByPrefix(query, projectPath);

        if (sessionTarget) {
            return sessionTarget;
        }

        // Try agent search
        const agents = ClaudeSession.findSubagents({
            query,
            project: projectPath,
            allProjects: !projectPath,
        });

        if (agents.length === 1) {
            return agents[0];
        }

        if (agents.length > 1) {
            return await promptSelectTarget(agents);
        }

        return null;
    }

    // No query — find most recent active session
    return findMostRecentSession(projectPath);
}

function getProjectDirs(projectPath?: string): string[] {
    if (projectPath) {
        const dir = resolve(PROJECTS_DIR, encodedProjectDir(projectPath));
        return existsSync(dir) ? [dir] : [];
    }

    if (!existsSync(PROJECTS_DIR)) {
        return [];
    }

    try {
        return readdirSync(PROJECTS_DIR)
            .map((d) => resolve(PROJECTS_DIR, d))
            .filter((d) => statSync(d).isDirectory());
    } catch {
        return [];
    }
}

function findSessionByPrefix(prefix: string, projectPath?: string): TailTarget | null {
    const lowerPrefix = prefix.toLowerCase();

    for (const baseDir of getProjectDirs(projectPath)) {
        try {
            for (const entry of readdirSync(baseDir)) {
                if (entry.endsWith(".jsonl") && entry.toLowerCase().startsWith(lowerPrefix)) {
                    return {
                        filePath: resolve(baseDir, entry),
                        label: entry.replace(".jsonl", ""),
                        sessionId: entry.replace(".jsonl", ""),
                        isAgent: false,
                    };
                }
            }
        } catch {
            continue;
        }
    }

    return null;
}

function findMostRecentSession(projectPath?: string): TailTarget | null {
    const dirs = getProjectDirs(projectPath);

    // Use statusline files to find the most recently active session
    if (existsSync(STATUSLINE_DIR)) {
        try {
            const files = readdirSync(STATUSLINE_DIR)
                .filter((f) => f.startsWith("statusline.") && f.endsWith(".state"))
                .map((f) => ({
                    name: f,
                    sessionId: f.replace("statusline.", "").replace(".state", ""),
                    mtime: statSync(resolve(STATUSLINE_DIR, f)).mtimeMs,
                }))
                .sort((a, b) => b.mtime - a.mtime);

            for (const file of files) {
                for (const baseDir of dirs) {
                    const jsonlPath = resolve(baseDir, `${file.sessionId}.jsonl`);

                    if (existsSync(jsonlPath)) {
                        return {
                            filePath: jsonlPath,
                            label: file.sessionId,
                            sessionId: file.sessionId,
                            isAgent: false,
                        };
                    }
                }
            }
        } catch {
            // Fall through to directory scan
        }
    }

    // Fallback: scan all project directories for most recently modified .jsonl
    let best: { filePath: string; sessionId: string; mtime: number } | null = null;

    for (const baseDir of dirs) {
        try {
            for (const f of readdirSync(baseDir)) {
                if (!f.endsWith(".jsonl")) {
                    continue;
                }

                const filePath = resolve(baseDir, f);
                const mtime = statSync(filePath).mtimeMs;

                if (!best || mtime > best.mtime) {
                    best = { filePath, sessionId: f.replace(".jsonl", ""), mtime };
                }
            }
        } catch {
            continue;
        }
    }

    if (!best) {
        return null;
    }

    return {
        filePath: best.filePath,
        label: best.sessionId,
        sessionId: best.sessionId,
        isAgent: false,
    };
}

async function promptSelectTarget(targets: TailTarget[]): Promise<TailTarget | null> {
    if (!process.stdout.isTTY) {
        console.error(pc.yellow("Multiple matches found. Use a more specific query or run in a TTY."));

        for (const t of targets) {
            console.error(`  ${t.label} — ${t.agentDescription ?? t.filePath}`);
        }

        return null;
    }

    const result = await p.select({
        message: "Multiple matches found. Select one:",
        options: targets.map((t) => ({
            value: t,
            label: t.agentDescription ?? t.label,
            hint: basename(t.filePath),
        })),
    });

    if (p.isCancel(result)) {
        process.exit(0);
    }

    return result;
}

async function resolveIncludeSpec(opts: TailOptions): Promise<IncludeSpec> {
    if (opts.include) {
        return IncludeSpec.parse(opts.include);
    }

    if (opts.raw) {
        return IncludeSpec.defaults();
    }

    if (opts.interactive) {
        return await runInteractiveSetup();
    }

    if (opts.follow && process.stdout.isTTY) {
        return await runInteractiveSetup();
    }

    return IncludeSpec.defaults();
}

async function runInteractiveSetup(): Promise<IncludeSpec> {
    if (!process.stdout.isTTY) {
        console.log(INCLUDE_HELP);
        process.exit(0);
    }

    p.intro(pc.cyan("Configure tail output"));

    const categories = await p.multiselect({
        message: "What to show?",
        options: [
            { value: "thinking", label: "Thinking/reasoning blocks" },
            { value: "tools", label: "Tool calls" },
            { value: "agents", label: "Agent details" },
        ],
        initialValues: ["thinking", "tools", "agents"],
    });

    if (p.isCancel(categories)) {
        process.exit(0);
    }

    const parts: string[] = [];

    if (categories.includes("thinking")) {
        parts.push("thinking");
    }

    if (categories.includes("tools")) {
        const toolInChars = await p.text({
            message: "Tool input max chars?",
            placeholder: "500",
            defaultValue: "500",
        });

        if (p.isCancel(toolInChars)) {
            process.exit(0);
        }

        const toolOutChars = await p.text({
            message: "Tool output max chars?",
            placeholder: "500",
            defaultValue: "500",
        });

        if (p.isCancel(toolOutChars)) {
            process.exit(0);
        }

        parts.push(`tools:in:${toolInChars}`);
        parts.push(`tools:out:${toolOutChars}`);
    }

    if (categories.includes("agents")) {
        const agentParts = await p.multiselect({
            message: "Agent details to show?",
            options: [
                { value: "input", label: "Agent launch prompt" },
                { value: "tools", label: "Agent tool calls" },
                { value: "result", label: "Agent final result" },
                { value: "thinking", label: "Agent thinking" },
            ],
            initialValues: ["input", "tools", "result"],
        });

        if (p.isCancel(agentParts)) {
            process.exit(0);
        }

        if (agentParts.includes("input")) {
            parts.push("agents:input");
        }

        if (agentParts.includes("tools")) {
            const agentToolIn = await p.text({
                message: "Agent tool input max chars?",
                placeholder: "50",
                defaultValue: "50",
            });

            if (p.isCancel(agentToolIn)) {
                process.exit(0);
            }

            const agentToolOut = await p.text({
                message: "Agent tool output max chars?",
                placeholder: "500",
                defaultValue: "500",
            });

            if (p.isCancel(agentToolOut)) {
                process.exit(0);
            }

            parts.push(`agents:tools:in:${agentToolIn}`);
            parts.push(`agents:tools:out:${agentToolOut}`);
        }

        if (agentParts.includes("result")) {
            parts.push("agents:result");
        }

        if (agentParts.includes("thinking")) {
            parts.push("agents:thinking");
        }
    }

    p.outro(pc.dim(`--include ${parts.join(",")}`));

    return IncludeSpec.parse(parts.join(","));
}
