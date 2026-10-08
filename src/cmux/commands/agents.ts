import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, resolve } from "node:path";
import { AiConfigStore } from "@genesiscz/utils/ai/config/AiConfigStore";

import { suggestCommand, suggestEnumFlag } from "@genesiscz/utils/cli";
import { logger, out } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import { type AccountBudget, accountChoiceMessage, liveAccountBudgets } from "../lib/account-budgets";
import {
    type AccountChoice,
    isSessionAgentId,
    pickSessionAccount,
    SESSION_AGENT_IDS,
    type SessionAgentId,
    sessionAgent,
} from "../lib/session-agents";
import { closeSession } from "../lib/session-close";
import { liveAdoptableSessions, liveSessionCloseIO } from "../lib/session-close-live";
import {
    liveSessionIO,
    parseFocusFlag,
    resolveSessionRepo,
    type SessionNewIO,
    type SessionNewResult,
    startDevSession,
} from "../lib/session-new";
import { fileSessionStore, openSessions, type SessionStore } from "../lib/session-store";

const { log } = logger.scoped("cmux-session");

interface SessionNewFlags {
    repo?: string;
    account?: string;
    model?: string;
    prompt?: string;
    promptFile?: string;
    name?: string;
    viaTmux?: boolean;
    focus?: string | boolean;
    /** Commander's `--no-cross-messages`: true unless that flag is given. */
    crossMessages?: boolean;
    json?: boolean;
}

interface AccountSource {
    accounts: AccountChoice[];
}

export interface SessionNewDeps {
    io: SessionNewIO;
    store: SessionStore;
    accounts: () => Promise<AccountSource>;
    budgets: (agent: SessionAgentId, accounts: readonly AccountChoice[]) => Promise<AccountBudget[]>;
}

async function liveAccounts(): Promise<AccountSource> {
    const config = await AiConfigStore.readOnly();
    return { accounts: config.accounts() };
}

function blank(value: string | undefined): string | undefined {
    const trimmed = value?.trim();
    return trimmed ? trimmed : undefined;
}

function sessionSlug(value: string): string {
    return (
        value
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "")
            .slice(0, 32) || "repo"
    );
}

function printHuman(name: string, result: SessionNewResult): void {
    out.println(`${name}  ${result.agent}  ${result.workspace}  ${result.surface}  ${result.window}`);
    out.println(result.cwd);

    if (result.tmuxSession) {
        out.println(`tmux ${result.tmuxSession}`);
    }

    out.println(result.command);
}

/** `tools cmux agents new <agent>`: a background workspace in the focused window, running that agent. */
export async function runSessionNew(
    agent: SessionAgentId,
    options: SessionNewFlags,
    deps: Partial<SessionNewDeps> = {}
): Promise<void> {
    const focus = parseFocusFlag(options.focus);

    if (!focus.ok) {
        out.error(
            suggestEnumFlag("tools cmux", "--focus", ["true", "false"], {
                subcommand: ["agents", "new", agent],
                given: focus.given,
            })
        );
        process.exitCode = 1;
        return;
    }

    const prompt = blank(options.prompt);
    const promptFile = blank(options.promptFile);

    if (prompt && promptFile) {
        out.error("pass only one of --prompt and --prompt-file");
        process.exitCode = 1;
        return;
    }

    const repo = options.repo?.trim();

    if (!repo) {
        out.error("--repo is required");
        process.exitCode = 1;
        return;
    }

    let absolutePrompt: string | undefined;

    if (promptFile) {
        absolutePrompt = resolve(promptFile);

        if (!existsSync(absolutePrompt) || !statSync(absolutePrompt).isFile()) {
            throw new Error(`no such prompt file: ${absolutePrompt}`);
        }
    }

    const io = deps.io ?? liveSessionIO();
    const store = deps.store ?? fileSessionStore();
    const source = await (deps.accounts ?? liveAccounts)();
    const requested = blank(options.account);

    if (!requested) {
        const enabled = source.accounts.filter(
            (entry) => entry.provider === sessionAgent(agent).provider && entry.enabled
        );
        const budgets = await (deps.budgets ?? liveAccountBudgets)(agent, enabled);
        out.error(
            accountChoiceMessage({
                agent,
                budgets,
                retry: suggestCommand(`tools cmux agents new ${agent}`, {
                    subcommand: ["agents", "new", agent],
                    add: ["--account", "<name>"],
                }),
            })
        );
        process.exitCode = 1;
        return;
    }

    const account = pickSessionAccount({ agent: sessionAgent(agent), accounts: source.accounts, requested });
    const cwd = resolveSessionRepo(repo, homedir(), process.cwd(), io.repoFs);
    const title = blank(options.name);
    const name = title ? sessionSlug(title) : `${agent}-${sessionSlug(basename(cwd))}-${io.nonce()}`;

    if (openSessions(store.read()).some((record) => record.name === name)) {
        throw new Error(`a session named "${name}" is already open; close it or pass another --name`);
    }

    const model = blank(options.model);
    const pidFile = store.pidFile(name);
    const result = await startDevSession(
        {
            agent,
            repo: cwd,
            account: account.name,
            ...(model ? { model } : {}),
            pidFile,
            prompt,
            promptFile: absolutePrompt,
            crossMessages: options.crossMessages !== false,
            name: title,
            viaTmux: options.viaTmux === true,
            focus: focus.focus,
            home: homedir(),
            cwd: process.cwd(),
        },
        io
    );

    store.append({
        type: "created",
        name,
        agent,
        account: account.name,
        model: model ?? null,
        cwd: result.cwd,
        window: result.window,
        workspace: result.workspace,
        surface: result.surface,
        tmuxSession: result.tmuxSession,
        pidFile,
        command: result.command,
        createdAt: new Date().toISOString(),
        createdBy: "agents-new",
    });
    log.debug({ name, agent, workspace: result.workspace }, "session recorded");

    if (options.json) {
        out.result({ name, account: account.name, model: model ?? null, ...result });
    } else {
        printHuman(name, result);
    }

    await out.flush();
}

interface CloseFlags {
    force?: boolean;
    killTmux?: boolean;
    grace?: string;
    dryRun?: boolean;
    json?: boolean;
}

async function runSessionClose(query: string, options: CloseFlags): Promise<void> {
    const grace = options.grace === undefined ? 10 : Number(options.grace);

    if (!Number.isFinite(grace) || grace < 0) {
        out.error(`--grace must be a non-negative number of seconds (got ${options.grace})`);
        process.exitCode = 2;
        return;
    }

    const report = await closeSession(
        query,
        { force: options.force, killTmux: options.killTmux, dryRun: options.dryRun, graceMs: grace * 1000 },
        liveSessionCloseIO(fileSessionStore())
    );

    if (options.json) {
        out.result(report);
    } else {
        out.println(
            `${report.outcome}  ${report.session}  ${report.workspace}${report.reason ? `  (${report.reason})` : ""}`
        );

        for (const note of report.notes) {
            out.println(`  ${note}`);
        }
    }

    if (report.outcome === "refused" || report.outcome === "partial") {
        process.exitCode = 1;
    }

    await out.flush();
}

async function runSessionList(options: { agent?: string; all?: boolean; json?: boolean }): Promise<void> {
    const wanted = (agent: string) => !options.agent || agent === options.agent;
    const open = openSessions(fileSessionStore().read()).filter((record) => wanted(record.agent));
    const recordedSurfaces = new Set(open.map((record) => record.surface));
    const adoptable = options.all
        ? (await liveAdoptableSessions()).filter(
              (session) => wanted(session.agent) && !recordedSurfaces.has(session.surface)
          )
        : [];

    if (options.json) {
        out.result(options.all ? { recorded: open, adoptable } : open);
        return;
    }

    if (open.length === 0 && adoptable.length === 0) {
        out.println(
            options.all ? "No agent sessions in cmux." : "No open sessions from agents new (--all adds the others)."
        );
        return;
    }

    for (const record of open) {
        out.println(
            `${record.name}  ${record.agent}  ${record.account}  ${record.workspace}  ${record.tmuxSession ?? "-"}  ${record.cwd}`
        );
    }

    for (const session of adoptable) {
        out.println(
            `${session.sessionId}  ${session.agent}  adoptable  ${session.workspace}  ${session.surface}  ${session.cwd}`
        );
    }
}

function addNewOptions(command: Command): Command {
    return command
        .requiredOption("--repo <name|path>", "Project name under ~/Tresors/Projects, or a directory path")
        .option(
            "--account <name>",
            "Account (required). Omit it to list every account with its 5h and weekly budget left"
        )
        .option("--model <id>", "Model id or alias, passed to tools <agent> run -m")
        .option("--prompt <text>", "Initial prompt. Passed after -- to tools <agent> run.")
        .option("--prompt-file <path>", "Read the prompt from a file when the workspace command runs")
        .option("--name <title>", "Session name and workspace title")
        .option("--via-tmux", "Run the agent inside a detached tmux session and attach the workspace to it")
        .option("--focus [value]", "Focus the new workspace: true or false (default: false)")
        .option(
            "--no-cross-messages",
            "Claude: do not pass --cross-messages (messages from tools claude message then wait for approval in bypass mode)"
        )
        .option("--json", "Print name, agent, account, workspace, surface, window, tmuxSession, cwd, command as JSON");
}

function addCloseOptions(command: Command): Command {
    return command
        .option("--force", "Close a workspace with no agent session, a running turn, or an agent that did not quit")
        .option("--kill-tmux", "Also kill the tmux session of a --via-tmux session")
        .option("--grace <seconds>", "How long to wait for the agent to quit", "10")
        .option("--dry-run", "Print the plan and the checks, close nothing")
        .option("--json", "Print the report as JSON");
}

async function guarded(run: () => Promise<void>): Promise<void> {
    try {
        await run();
    } catch (error) {
        out.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    }
}

/** `tools cmux agents new|list|close`: agent sessions in cmux workspaces. */
export function registerAgentsCommand(program: Command): void {
    const agents = program
        .command("agents")
        .description("Start, list and close Claude, Grok or Codex sessions in cmux workspaces");

    addNewOptions(
        agents
            .command("new [agent]")
            .description(`Start ${SESSION_AGENT_IDS.join(", ")} in a background workspace of the focused window`)
    ).action(async (name: string | undefined, options: SessionNewFlags) => {
        if (!name || !isSessionAgentId(name)) {
            out.error(
                `${name ? `"${name}" is not an agent. ` : ""}Choose one of: ${SESSION_AGENT_IDS.join(", ")}\n` +
                    `  tools cmux agents new ${SESSION_AGENT_IDS[0]} --repo <name>`
            );
            process.exitCode = 2;
            return;
        }

        await guarded(() => runSessionNew(name, options));
    });

    agents
        .command("list")
        .description("Sessions agents new opened that are not closed yet; --all adds every other agent session in cmux")
        .option("--agent <id>", `Only this agent: ${SESSION_AGENT_IDS.join(", ")}`)
        .option("--all", "Also list agent sessions agents new did not open (close can adopt them)")
        .option("--json", "Print the records as JSON")
        .action(async (options: { agent?: string; all?: boolean; json?: boolean }) => {
            await guarded(() => runSessionList(options));
        });

    addCloseOptions(
        agents
            .command("close <session>")
            .description(
                "Quit the agent, then close its workspace (agents new) or only its surface (an adopted session: a session id, surface or workspace ref)"
            )
    ).action(async (query: string, options: CloseFlags) => {
        await guarded(() => runSessionClose(query, options));
    });
}
