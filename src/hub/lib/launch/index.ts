import { createHash } from "node:crypto";
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { SESSION_AGENT_IDS, sessionAgent } from "@app/cmux/lib/session-agents";
import { listSessionRepos, liveRepoFs } from "@app/cmux/lib/session-new";
import type {
    AgentNewInput,
    AgentNewReceiptDto,
    LaunchAccountDto,
    LaunchAgentDto,
    LaunchOptionsDto,
} from "@app/dev-dashboard/contract/launch";
import { AiConfigStore } from "@genesiscz/utils/ai/config/AiConfigStore";
import type { AccountEntry } from "@genesiscz/utils/ai/config/schema";
import type { AccountUsageSnapshot } from "@genesiscz/utils/ai/providers/account-features";
import { snapshotOfAccount } from "@genesiscz/utils/ai/providers/account-features";
import { rankAccounts } from "@genesiscz/utils/ai/usage/account-rank";
import { readSnapshotsCache } from "@genesiscz/utils/ai/usage-poll/legacy-cache";
import { execTool } from "@genesiscz/utils/cli";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { toolDataDir } from "@genesiscz/utils/storage/root";

/**
 * Start or relaunch an agent (F21). `launchOptions` is what the phone's New agent sheet shows; `startAgent` is its
 * Start button. Both only read the usage cache the poller wrote: no account is fetched, so no refresh token is
 * spent. The ranking is each provider's own ranker (`rankAccounts`, the U4 table keyed by provider).
 */

export interface LaunchDeps {
    accounts?: () => Promise<AccountEntry[]>;
    snapshots?: () => Promise<Record<string, AccountUsageSnapshot[]>>;
    repos?: () => string[];
    now?: Date;
}

async function liveAccounts(): Promise<AccountEntry[]> {
    // readOnly(): a plain load may migrate the config, and this is a read.
    return (await AiConfigStore.readOnly()).accounts();
}

async function cachedSnapshots(): Promise<Record<string, AccountUsageSnapshot[]>> {
    const cache = await readSnapshotsCache();
    return Object.fromEntries(
        Object.entries(cache?.providers ?? {}).map(([provider, slice]) => [provider, slice.accounts])
    );
}

function liveRepos(): string[] {
    const home = homedir();
    const projects = join(home, "Tresors", "Projects");
    const changed = (name: string): number => {
        try {
            return statSync(join(projects, name)).mtimeMs;
        } catch (error) {
            logger.debug({ error, name }, "launch: a project folder could not be read");
            return 0;
        }
    };

    return listSessionRepos(home, liveRepoFs())
        .map((name) => ({ name, at: changed(name) }))
        .sort((a, b) => b.at - a.at)
        .map((entry) => entry.name);
}

const TIER_ORDER: Readonly<Record<LaunchAccountDto["tier"], number>> = {
    ready: 0,
    "session-starved": 1,
    "weekly-blocked": 2,
    "no-data": 3,
};

export async function launchOptions(deps: LaunchDeps = {}): Promise<LaunchOptionsDto> {
    const [accounts, snapshots] = await Promise.all([
        (deps.accounts ?? liveAccounts)(),
        (deps.snapshots ?? cachedSnapshots)(),
    ]);
    const now = deps.now ?? new Date();

    const agents: LaunchAgentDto[] = SESSION_AGENT_IDS.map((id) => {
        const provider = sessionAgent(id).provider;
        const enabled = accounts.filter((account) => account.provider === provider && account.enabled);
        const ranked = rankAccounts(snapshots[provider] ?? [], { now });
        const rows = enabled.map((account): LaunchAccountDto => {
            const rank = snapshotOfAccount(ranked, account);

            if (!rank) {
                return {
                    id: account.id,
                    name: account.name,
                    tier: "no-data",
                    sessionLeftPct: null,
                    longLeftPct: null,
                    sessions: 0,
                    why: "no usage reading yet",
                };
            }

            return {
                id: account.id,
                name: account.name,
                tier: rank.tier,
                sessionLeftPct: rank.tier === "no-data" ? null : Math.round(rank.sessionHeadroomPct),
                longLeftPct: rank.tier === "no-data" ? null : Math.round(rank.longHeadroomPct),
                sessions: rank.sessions,
                why: rank.why,
            };
        });
        const order = new Map(ranked.map((rank, index) => [rank.accountId || rank.accountName, index]));
        rows.sort(
            (a, b) =>
                TIER_ORDER[a.tier] - TIER_ORDER[b.tier] ||
                (order.get(a.id) ?? order.get(a.name) ?? 999) - (order.get(b.id) ?? order.get(b.name) ?? 999)
        );
        return { id, accounts: rows };
    });

    return { generatedAt: now.toISOString(), agents, repos: (deps.repos ?? liveRepos)() };
}

/** An inline prompt is typed into the terminal; a longer one goes through a file (`--prompt-file`). */
const INLINE_PROMPT_MAX = 2_000;

export interface StartAgentDeps {
    run?: (args: string[]) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
    promptDir?: () => string;
}

function lastLine(text: string): string | null {
    const lines = text
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
    return lines.at(-1) ?? null;
}

function record(value: unknown): Record<string, unknown> {
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function str(value: unknown): string | null {
    return typeof value === "string" && value !== "" ? value : null;
}

/** Runs `tools cmux agents new <agent> --repo <repo> --account <account> --json` and reads what it recorded. */
export async function startAgent(input: AgentNewInput, deps: StartAgentDeps = {}): Promise<AgentNewReceiptDto> {
    const agent = SESSION_AGENT_IDS.find((id) => id === input.agent);

    if (!agent) {
        return {
            started: false,
            name: null,
            workspace: null,
            cwd: null,
            error: `unknown agent ${input.agent}; one of ${SESSION_AGENT_IDS.join(", ")}`,
        };
    }

    const args = ["cmux", "agents", "new", agent, "--repo", input.repo, "--account", input.account, "--json"];
    const prompt = input.prompt?.trim();

    if (prompt && prompt.length > INLINE_PROMPT_MAX) {
        const dir = deps.promptDir?.() ?? toolDataDir("dev-dashboard", "launch-prompts");
        mkdirSync(dir, { recursive: true });
        const file = join(dir, `${createHash("sha256").update(prompt).digest("hex").slice(0, 16)}.md`);
        writeFileSync(file, prompt, { mode: 0o600 });
        args.push("--prompt-file", file);
    } else if (prompt) {
        args.push("--prompt", prompt);
    }

    if (input.name?.trim()) {
        args.push("--name", input.name.trim());
    }

    if (input.model?.trim()) {
        args.push("--model", input.model.trim());
    }

    const run = deps.run ?? ((argv: string[]) => execTool(argv, { timeout: 60_000 }));
    const result = await run(args);
    logger.info({ agent, repo: input.repo, account: input.account, exitCode: result.exitCode }, "launch: agents new");

    if (result.exitCode !== 0) {
        return {
            started: false,
            name: null,
            workspace: null,
            cwd: null,
            error: lastLine(result.stderr) ?? `exit ${result.exitCode}`,
        };
    }

    let parsed: unknown;

    try {
        parsed = SafeJSON.parse(result.stdout, { strict: true });
    } catch (error) {
        logger.warn({ error, stdout: result.stdout.slice(0, 200) }, "launch: agents new printed no JSON");
        return { started: true, name: null, workspace: null, cwd: null, error: null };
    }

    const fields = record(parsed);
    return {
        started: true,
        name: str(fields.name),
        workspace: str(fields.workspace),
        cwd: str(fields.cwd),
        error: null,
    };
}
