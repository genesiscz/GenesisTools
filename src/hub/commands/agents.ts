import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { formatRelativeTime } from "@genesiscz/utils/format";
import { out } from "@genesiscz/utils/logger";
import { createBoxTable, formatDotStatus, renderCliHeader, truncateDisplay } from "@genesiscz/utils/table";
import type { Command } from "commander";
import pc from "picocolors";
import type { AgentCounts, AgentCountsOptions } from "../lib/agents/counts";
import type { AgentDetail, HubAgentsOptions } from "../lib/agents/index";
import type { AgentMailOptions } from "../lib/agents/mail";
import {
    type AgentMail,
    type AgentNode,
    type AgentParent,
    type AgentStatus,
    type AgentsTree,
    DEFAULT_AGENTS_LIMIT,
    DEFAULT_AGENTS_SINCE_HOURS,
} from "../lib/agents/types";
import { hoursArg, limitArg } from "./agents-args";

export interface AgentsFlags {
    since?: number;
    limit?: number;
    session?: string;
    /** One agent with its whole spawn prompt, instead of the list. */
    agent?: string;
    json?: boolean;
}

const COLUMNS = ["AGENT", "HARNESS", "KIND", "STATUS", "MODEL", "TOOLS", "MAIL", "LAST", "ID"];
const COUNTS_COMMAND = `${toolCommand("hub agents counts")} --session <lead session id> --ids <agent id,agent id> --json`;
const MAIL_COMMAND = `${toolCommand("hub agents mail")} --session <lead session id> --agent <agent id>`;

const STATUS_DOT: Record<AgentStatus, "ok" | "warn" | "err" | "dim"> = {
    running: "ok",
    idle: "warn",
    completed: "dim",
    failed: "err",
    killed: "err",
};

function ago(iso: string | null): string {
    return iso ? formatRelativeTime(new Date(iso), { compact: true }) : "";
}

function label(node: AgentNode): string {
    return node.name ?? node.description ?? node.id;
}

function pushRows(table: ReturnType<typeof createBoxTable>, nodes: AgentNode[], depth: number): void {
    for (const node of nodes) {
        const indent = "  ".repeat(depth);
        table.push([
            `${indent}${pc.white(truncateDisplay(label(node), 34 - indent.length))}`,
            node.harness,
            node.kind,
            formatDotStatus(STATUS_DOT[node.status], node.status),
            truncateDisplay(node.model ?? "", 18),
            String(node.toolCalls),
            node.unreadMail > 0 ? pc.yellow(String(node.unreadMail)) : "",
            ago(node.lastAt),
            pc.dim(node.id),
        ]);
        pushRows(table, node.children, depth + 1);
    }
}

function renderParent(parent: AgentParent): void {
    const title = truncateDisplay(parent.title ?? "(untitled)", 60);
    const live = parent.live ? pc.green("● live") : pc.dim("○");
    out.println(
        `${live} ${pc.bold(title)} ${pc.dim(`${parent.sessionId.slice(0, 8)} · ${parent.project ?? ""} · ${ago(parent.lastAt)}`)}`
    );

    if (parent.children.length === 0) {
        out.println(pc.dim("  no agents"));
        return;
    }

    const table = createBoxTable(COLUMNS);
    pushRows(table, parent.children, 0);
    out.println(table.toString());
}

function count(nodes: AgentNode[]): number {
    return nodes.reduce((sum, node) => sum + 1 + count(node.children), 0);
}

export interface AgentsCommandDeps {
    tree: (options: HubAgentsOptions) => Promise<AgentsTree>;
    agent: (options: HubAgentsOptions & { agent: string }) => Promise<AgentDetail | null>;
    mail: (options: AgentMailOptions) => Promise<AgentMail>;
    counts: (options: AgentCountsOptions) => Promise<AgentCounts>;
}

// Each door loads its own library on use: the tree pulls the session index and every provider
// (about 270 modules), while `counts`, which the hub calls every 5 s per running row, needs about 60.
const DEFAULT_DEPS: AgentsCommandDeps = {
    tree: async (options) => (await import("../lib/agents/index")).hubAgents(options),
    agent: async (options) => (await import("../lib/agents/index")).hubAgent(options),
    mail: async (options) => (await import("../lib/agents/mail")).agentMail(options),
    counts: async (options) => (await import("../lib/agents/counts")).agentCounts(options),
};

/** One agent with its whole spawn prompt: `--agent` on `tools hub agents` and `tools ai sessions subagents --all`. */
async function printAgent(flags: AgentsFlags & { agent: string }, deps: AgentsCommandDeps): Promise<void> {
    const detail = await deps.agent({
        hours: flags.since,
        limit: flags.limit,
        session: flags.session,
        agent: flags.agent,
    });
    if (!detail) {
        out.log.error(`No agent ${flags.agent}${flags.session ? ` under session ${flags.session}` : " in the window"}`);
        process.exitCode = 1;
        return;
    }

    if (flags.json) {
        out.result(detail);
        return;
    }

    const table = createBoxTable(COLUMNS);
    pushRows(table, [detail.agent], 0);
    out.println(table.toString());
    out.println(detail.agent.spawnPrompt ?? pc.dim("(no spawn prompt)"));
}

/** The cross-session tree, printed. Shared by `tools hub agents` and `tools ai sessions subagents --all`. */
export async function printAgentsTree(flags: AgentsFlags, deps: AgentsCommandDeps = DEFAULT_DEPS): Promise<void> {
    if (flags.agent) {
        await printAgent({ ...flags, agent: flags.agent }, deps);
        return;
    }

    const result = await deps.tree({ hours: flags.since, limit: flags.limit, session: flags.session });

    if (flags.json) {
        out.result(result);
        return;
    }

    const agentCount = result.parents.reduce((sum, parent) => sum + count(parent.children), 0);
    renderCliHeader("Agents", `${result.parents.length} sessions · ${agentCount} agents`);
    for (const parent of result.parents) {
        renderParent(parent);
    }

    if (result.orphans.length > 0) {
        out.println(pc.bold("Workers with no listed session"));
        const table = createBoxTable(COLUMNS);
        pushRows(table, result.orphans, 0);
        out.println(table.toString());
    }

    out.println(pc.dim(`Mail of one teammate: ${MAIL_COMMAND}`));
}

export function registerAgentsCommand(program: Command, deps: AgentsCommandDeps = DEFAULT_DEPS): void {
    const agents = program
        .command("agents")
        .description("Agent sessions with their sub-agents, teammates and codex/grok workers (the hub's Agents mode)")
        .option("--since <dur>", `window: 90m, 24h, 7d (default ${DEFAULT_AGENTS_SINCE_HOURS}h)`, hoursArg)
        .option("--limit <n>", `at most this many parent sessions (default ${DEFAULT_AGENTS_LIMIT})`, limitArg)
        .option("--session <id>", "one parent session (id or id prefix), whatever its age")
        .option("--agent <id>", "one agent (id or name) with its whole spawn prompt, instead of the list")
        .option("--json", "the tree as JSON on stdout (the hub reads this)")
        .action((flags: AgentsFlags) => printAgentsTree(flags, deps));

    agents
        .command("mail")
        .description("One teammate's mail: received (with arrival time), sent, and inbox entries not delivered yet")
        .option("--session <id>", "the lead session (id or id prefix)")
        .option("--agent <id>", "the teammate's agent id (aE-sharedkit-4743…)")
        .option("--json", "machine-readable output")
        .action(async (_flags: unknown, command: Command) => {
            // `agents` has its own `--session`, and commander hands a flag to the parent before the
            // subcommand sees it (the hub's root keeps non-positional options for `-v`), so
            // `agents mail --session X` lands on `agents`. Read the merged set instead.
            const flags: { session?: string; agent?: string; json?: boolean } = command.optsWithGlobals();
            if (!flags.session || !flags.agent) {
                out.log.error("mail needs both --session <lead session> and --agent <agent id>");
                out.log.info(MAIL_COMMAND);
                process.exitCode = 1;
                return;
            }

            try {
                const mail = await deps.mail({ session: flags.session, agent: flags.agent });

                if (flags.json) {
                    out.result(mail);
                    return;
                }

                renderCliHeader("Mail", `${flags.agent}`);
                for (const item of mail.received) {
                    out.println(
                        `${pc.cyan("←")} ${item.at ?? ""} ${pc.bold(item.from)}: ${truncateDisplay(item.text, 100)}`
                    );
                }

                for (const item of mail.sent) {
                    out.println(
                        `${pc.magenta("→")} ${item.at ?? ""} ${pc.bold(item.to)}: ${truncateDisplay(item.text, 100)}`
                    );
                }

                for (const item of mail.unread) {
                    out.println(
                        `${pc.yellow("✉")} ${item.at ?? ""} ${pc.bold(item.from)}: ${truncateDisplay(item.text, 100)}`
                    );
                }
            } catch (error) {
                out.log.error(error instanceof Error ? error.message : String(error));
                process.exitCode = 1;
            }
        });

    agents
        .command("counts")
        .description(
            "Tool calls, last activity, status and size of a few agents of one session: the hub refreshes running rows with this"
        )
        .option("--session <id>", "the lead session (id, id prefix or transcript path)")
        .option("--ids <ids>", "comma-separated agent ids (aE-sharedkit-4743…,a0564…)")
        .option("--json", "machine-readable output")
        .action(async (_flags: unknown, command: Command) => {
            // Same as mail: `agents` owns a `--session` too and takes the flag first.
            const flags: { session?: string; ids?: string; json?: boolean } = command.optsWithGlobals();
            const ids = (flags.ids ?? "")
                .split(",")
                .map((id) => id.trim())
                .filter(Boolean);
            if (!flags.session || ids.length === 0) {
                out.log.error("counts needs --session <lead session> and --ids <id,id,…>");
                out.log.info(COUNTS_COMMAND);
                process.exitCode = 1;
                return;
            }

            try {
                const counts = await deps.counts({ session: flags.session, ids });
                if (flags.json) {
                    out.result(counts);
                    return;
                }

                for (const agent of counts.agents) {
                    out.println(
                        `${agent.status.padEnd(9)} ${String(agent.toolCalls).padStart(5)} tools  ${ago(agent.lastAt)}  ${agent.id}`
                    );
                }
            } catch (error) {
                out.log.error(error instanceof Error ? error.message : String(error));
                process.exitCode = 1;
            }
        });
}
