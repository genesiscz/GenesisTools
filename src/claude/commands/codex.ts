import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { resolveProxyAccountEntry } from "@app/ai-proxy/lib/account-refs";
import { loadConfigFresh } from "@app/ai-proxy/lib/config";
import {
    agentAccounts,
    agentLogins,
    choiceLogin,
    isError,
    namedAccount,
    type Resolved,
    recordFields,
    type SessionAccountChoice,
} from "@app/ai-proxy/lib/sessions/accounts";
import {
    closeSessionRecord,
    hashSessionKey,
    listSessionRecords,
    type MeteredConfirmation,
    openSessionRecord,
    SESSION_LOGIN_FIELD,
    type SessionAgent,
    updateSessionRecord,
    whenSessionRecordFree,
} from "@app/ai-proxy/lib/sessions/records";
import type { AiProxyConfig } from "@app/ai-proxy/lib/types";
import {
    agentsArgs,
    claudeCodexConfigRoot,
    leadPrompt,
    sessionAgents,
    writeAgentFiles,
} from "@app/claude/lib/codex-session/agents";
import {
    autoAccount,
    claudeModelByAlias,
    passthroughSets,
    resolveSessionEffort,
    resolveSessionModel,
    SESSION_MODEL_ALIASES,
    sessionArgs,
    sessionEnv,
} from "@app/claude/lib/codex-session/launch";
import { sessionKeyProblem } from "@app/claude/lib/codex-session/proxy-check";
import { guardSharedModel } from "@app/claude/lib/codex-session/settings-guard";
import { ensureOnboardingSkippedForOAuthToken } from "@app/claude/lib/launch-env";
import { scoreAccounts, sortGrouped } from "@app/claude/lib/usage/account-picker";
import { getSharedAccountsUsage } from "@app/claude/lib/usage/shared-cache";
import { pickSmart } from "@app/claude/lib/usage/smart-alias";
import * as p from "@clack/prompts";
import { AiConfigStore } from "@genesiscz/utils/ai/config/AiConfigStore";
import { mergeCodexModelRecords, readCodexModelsCache } from "@genesiscz/utils/ai/openai/codex-models";
import { resolveOpenAiSubModel } from "@genesiscz/utils/ai/openai/sub-models";
import { pollAccounts } from "@genesiscz/utils/ai/usage-poll/poll";
import { isInteractive } from "@genesiscz/utils/cli";
import { logger, out } from "@genesiscz/utils/logger";
import { processStartMs } from "@genesiscz/utils/process-identity";
import type { Command } from "commander";
import pc from "picocolors";
import { pickSessionForResume } from "./resume";
import { ensureProxyUp, proxyBaseUrl, spawnClaude } from "./run";

interface CodexSessionOptions {
    model?: string;
    effort?: string;
    claude?: string;
    grok?: string;
    compact?: string;
    isolated?: boolean;
    allowMetered: string[];
    resume?: string | boolean;
    start?: boolean;
    port?: string;
}

/** Prints the error and exits 1. */
async function fail(message: string): Promise<never> {
    out.error(pc.red(message));
    await out.flush();
    process.exit(1);
}

/** Open sessions per login, so `auto` spreads parallel sessions. */
function sessionsPerLogin(agent: SessionAgent): Record<string, number> {
    const counts: Record<string, number> = {};

    for (const record of listSessionRecords()) {
        const login = record[SESSION_LOGIN_FIELD[agent]];

        if (!record.closedAt && login) {
            counts[login] = (counts[login] ?? 0) + 1;
        }
    }

    return counts;
}

async function codexOrGrokAccount(
    agent: "codex" | "grok",
    spec: string,
    config: AiProxyConfig,
    store: AiConfigStore
): Promise<Resolved<SessionAccountChoice>> {
    const proxyAccounts = agentAccounts(config.accounts, agent);
    const logins = agentLogins(store, agent);

    if (spec !== "auto") {
        return namedAccount(spec, proxyAccounts, logins, agent);
    }

    return autoAccount({
        agent,
        logins,
        snapshots: await pollAccounts({ providers: [agent] }),
        sessions: sessionsPerLogin(agent),
        // A configured account with no login link (the legacy Codex account on ~/.codex/auth.json).
        fallback: proxyAccounts.filter((account) => !resolveProxyAccountEntry(account, store)),
    });
}

/**
 * The Claude side keeps Claude's own scorer: `auto` is the `cc opus` pick (weekly Opus headroom) among the Claude
 * logins. `hasFable` comes from the same usage reading.
 */
async function claudeAccount(
    spec: string,
    config: AiProxyConfig,
    store: AiConfigStore
): Promise<Resolved<SessionAccountChoice & { hasFable: boolean }>> {
    const logins = agentLogins(store, "claude");
    const usage =
        logins.length > 0
            ? await getSharedAccountsUsage({ accountFilter: logins.map((login) => login.name) }).catch((error) => {
                  logger.warn({ error }, "[codex] Claude usage unavailable; auto cannot rank the Claude logins");
                  return [];
              })
            : [];
    const scored = sortGrouped(scoreAccounts(usage, { modelFamily: "opus" }));
    const fableOf = (login: string | undefined) => scored.some((row) => row.accountName === login && row.limits?.fable);

    if (spec !== "auto") {
        const named = namedAccount(spec, agentAccounts(config.accounts, "claude"), logins, "claude");
        return isError(named) ? named : { ...named, hasFable: fableOf(choiceLogin(named, store)) };
    }

    const pick = pickSmart("opus", scored);

    if (!pick) {
        return {
            error: "auto found no Claude login with Opus headroom. Name one with --claude, or pass --claude none.",
        };
    }

    const runnerUp = scored.find((row) => row.accountName !== pick.accountName && row.tier === "ready");
    return {
        login: pick.accountName,
        label: pick.accountName,
        how: "auto",
        why: pick.line,
        ...(runnerUp ? { runnerUp: `${runnerUp.accountName} (${runnerUp.why})` } : {}),
        metered: false,
        hasFable: fableOf(pick.accountName),
    };
}

function describeChoice(agent: string, choice: SessionAccountChoice): string {
    const how = choice.how === "named" ? "" : ` ${pc.dim(`(${choice.how}${choice.why ? `: ${choice.why}` : ""})`)}`;
    const kind = choice.proxyAccount ? pc.dim(" (configured proxy account)") : "";
    const runnerUp = choice.runnerUp ? `\n    ${pc.dim(`runner-up: ${choice.runnerUp}`)}` : "";
    return `${pc.cyan("▸")} ${agent} → ${pc.bold(choice.label)}${kind}${how}${runnerUp}`;
}

/** P6: a metered account needs `--allow-metered <account>` or a yes, and a non-interactive launch without the flag fails. */
async function confirmMetered(choices: SessionAccountChoice[], allowed: string[]): Promise<MeteredConfirmation[]> {
    const confirmations: MeteredConfirmation[] = [];

    for (const choice of choices) {
        if (!choice.metered || !choice.proxyAccount) {
            continue;
        }

        const name = choice.proxyAccount.name;
        out.printlnErr(
            pc.yellow(`⚠ "${name}" (${choice.proxyAccount.provider}) is billed per token, not a subscription.`)
        );

        if (allowed.includes(name)) {
            confirmations.push({ account: name, confirmedAt: new Date().toISOString(), how: "flag" });
            continue;
        }

        if (!isInteractive()) {
            await fail(`Refusing to bill "${name}" per token without --allow-metered ${name}.`);
        }

        const answer = await p.confirm({ message: `Bill "${name}" per token for this session?`, initialValue: false });

        if (p.isCancel(answer) || answer !== true) {
            await fail(`Not launched: "${name}" is billed per token.`);
        }

        confirmations.push({ account: name, confirmedAt: new Date().toISOString(), how: "prompt" });
    }

    return confirmations;
}

function compactPercent(raw: string | undefined, fallback: number): Resolved<{ percent: number }> {
    if (raw === undefined) {
        return { percent: fallback };
    }

    const percent = Number.parseInt(raw, 10);
    return Number.isInteger(percent) && percent >= 1 && percent <= 100 && String(percent) === raw.trim()
        ? { percent }
        : { error: `--compact takes a whole percent from 1 to 100, got "${raw}".` };
}

export async function runCodexSession(
    accountSpec: string | undefined,
    opts: CodexSessionOptions,
    passthrough: string[]
): Promise<void> {
    if (opts.model && passthroughSets(passthrough, "--model")) {
        await fail("Pass the model once: -m, or --model after --, not both.");
    }

    if (opts.effort && passthroughSets(passthrough, "--effort")) {
        await fail("Pass the effort once: -e, or --effort after --, not both.");
    }

    const loaded = await loadConfigFresh();
    const port = opts.port === undefined ? undefined : Number.parseInt(opts.port, 10);

    if (port !== undefined && !(Number.isInteger(port) && port > 0 && port < 65536)) {
        return fail(`--port takes a TCP port, got "${opts.port}".`);
    }

    // Another proxy (a second one for tests) is never started by the launcher: only the configured one is.
    const config = port === undefined ? loaded : { ...loaded, listen: { ...loaded.listen, port } };
    const catalog = mergeCodexModelRecords({ cache: readCodexModelsCache(), overrides: config.codexModels ?? {} });
    const codexModel = (slug: string) => catalog.get(slug);
    const model = resolveSessionModel(opts.model, codexModel);

    if (isError(model)) {
        return fail(model.error);
    }

    const effort = resolveSessionEffort(model.info, opts.effort);

    if (isError(effort)) {
        return fail(effort.error);
    }

    const compact = compactPercent(opts.compact, model.info.compactPercent);

    if (isError(compact)) {
        return fail(compact.error);
    }

    const store = await AiConfigStore.readOnly();
    const codex = await codexOrGrokAccount("codex", accountSpec ?? "auto", config, store);

    if (isError(codex)) {
        return fail(codex.error);
    }

    const claudeSpec = opts.claude ?? "auto";
    const claude = claudeSpec === "none" ? undefined : await claudeAccount(claudeSpec, config, store);

    if (claude && isError(claude)) {
        return fail(claude.error);
    }

    const grok = opts.grok ? await codexOrGrokAccount("grok", opts.grok, config, store) : undefined;

    if (grok && isError(grok)) {
        return fail(grok.error);
    }

    out.printlnErr(describeChoice("codex", codex));

    if (claude) {
        out.printlnErr(describeChoice("claude", claude));
    } else {
        out.printlnErr(
            pc.yellow(
                "⚠ No Claude account: the opus subagent, Claude models and Claude Code's auto-mode classifier are refused."
            )
        );
    }

    if (grok) {
        out.printlnErr(describeChoice("grok", grok));
    }

    const metered = await confirmMetered(
        [codex, ...(claude ? [claude] : []), ...(grok ? [grok] : [])],
        opts.allowMetered
    );

    await ensureProxyUp(config, opts.start !== false && port === undefined);

    const resumed =
        opts.resume === undefined || opts.resume === false
            ? undefined
            : await pickSessionForResume(typeof opts.resume === "string" ? opts.resume : undefined, {
                  allProjects: false,
              });
    const sessionId = resumed?.sessionId ?? randomUUID();
    const codexLogin = choiceLogin(codex, store);
    const claudeLogin = claude ? choiceLogin(claude, store) : undefined;
    const agents = sessionAgents({
        codexModel,
        ...(claude ? { claude: { fable: claude.hasFable } } : {}),
        ...(codexLogin ? { codexAccount: codexLogin } : {}),
    });
    const configDir = opts.isolated ? join(claudeCodexConfigRoot(), sessionId) : undefined;

    if (configDir) {
        mkdirSync(configDir, { recursive: true });
        writeAgentFiles(configDir, agents);
    }

    // The child reads .claude.json from the folder it gets as CLAUDE_CONFIG_DIR: the isolated one under --isolated.
    await ensureOnboardingSkippedForOAuthToken(configDir);

    const agentArgs = configDir ? [] : agentsArgs(passthrough, agents);
    const ownAgents = configDir || agentArgs.length > 0 ? Object.keys(agents) : undefined;
    const { key, reopened } = await whenSessionRecordFree(() =>
        openSessionRecord({
            id: sessionId,
            ...recordFields("codex", codex, store),
            ...recordFields("claude", claude, store),
            ...recordFields("grok", grok, store),
            cwd: process.cwd(),
            launcherPid: process.pid,
            model: model.slug,
            effort: effort.effort,
            window: model.info.window,
            // A user-provided --settings may override the launch limit, so its effective value is unknown here.
            ...(!passthrough.some((arg) => arg === "--settings" || arg.startsWith("--settings="))
                ? { pickerContextTokens: model.info.usableTokens }
                : {}),
            compactPercent: compact.percent,
            cacheKeyPolicy: "claude-session",
            ...(ownAgents ? { agents: ownAgents } : {}),
            meteredConfirmed: metered,
        })
    );
    const keyHash = hashSessionKey(key);
    const keyProblem = await sessionKeyProblem({ baseUrl: proxyBaseUrl(config), key, model: `codex/${model.slug}` });

    if (keyProblem) {
        await whenSessionRecordFree(() =>
            closeSessionRecord({ id: sessionId, reason: "exited", expectedKeyHash: keyHash })
        );
        return fail(keyProblem);
    }

    const claudeIds = claude
        ? {
              haiku: claudeModelByAlias("haiku"),
              sonnet: claudeModelByAlias("sonnet"),
              opus: claudeModelByAlias("opus"),
          }
        : undefined;
    const subscriptionType = claudeLogin
        ? (store.account(claudeLogin)?.credentials.secondary?.subscriptionType ?? undefined)
        : undefined;
    const launchEnv = sessionEnv(process.env, {
        baseUrl: proxyBaseUrl(config),
        key,
        model: `codex/${model.slug}`,
        ...(claudeIds?.haiku && claudeIds.opus
            ? {
                  claude: {
                      haiku: claudeIds.haiku,
                      ...(claudeIds.sonnet ? { sonnet: claudeIds.sonnet } : {}),
                      opus: claudeIds.opus,
                      ...(subscriptionType ? { subscriptionType } : {}),
                  },
              }
            : {}),
        smallCodexModel: `codex/${resolveOpenAiSubModel("luna")}:low`,
        // The model's whole window: Codex's own 95% `usablePercent` left compaction at about 408K of 500K
        // (2026-10-27); Claude Code keeps its own output reserve inside the window and compacts at `compact.percent`.
        maxContextTokens: model.info.window,
        compactPercent: compact.percent,
        accountLabel: [`codex:${codex.label}`, ...(claude ? [`claude:${claude.label}`] : [])].join("+"),
    });

    if (configDir) {
        launchEnv.CLAUDE_CONFIG_DIR = configDir;
    }

    const args = sessionArgs({
        sessionId,
        resume: resumed !== undefined,
        effort: effort.effort,
        agents: agentArgs,
        settingsEnv: {
            CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(model.info.window),
            CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(model.info.window),
            CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: String(compact.percent),
        },
        leadPrompt: leadPrompt(agents),
        passthrough,
    });

    out.printlnErr(
        pc.dim(
            `${reopened ? "Resuming" : "Starting"} Claude Code on ${pc.magenta(`codex/${model.slug}`)} at ${effort.effort}, ` +
                `window ${Math.round(model.info.window / 1000)}k, compact at ${compact.percent}%, session ${sessionId}` +
                (configDir ? `, config ${configDir}` : "")
        )
    );
    logger.info(
        {
            sessionId,
            codex: codex.label,
            claude: claude?.label,
            model: model.slug,
            effort: effort.effort,
        },
        "[codex] launching a claude codex session"
    );

    // A /model pick in this session would become every other session's default through the shared settings.
    const modelGuard = configDir ? undefined : guardSharedModel();
    let code: number;
    // Claude Code owns the terminal until it exits: a warning printed meanwhile draws over its screen (2026-10-27,
    // the model guard's). The day log still gets every line.
    const consoleLevel = logger.level;
    logger.level = "silent";

    try {
        code = await spawnClaude(args, launchEnv, (pid) => {
            whenSessionRecordFree(() =>
                updateSessionRecord({
                    id: sessionId,
                    expectedKeyHash: keyHash,
                    change: (record) => {
                        record.claudePid = pid;
                        record.claudePidStartMs = processStartMs(pid) ?? undefined;
                    },
                })
            ).catch((err) => logger.warn({ err, session: sessionId }, "[codex] could not record the Claude Code pid"));
        });
    } finally {
        logger.level = consoleLevel;
        // Also when the spawn throws: an open record would count as a live session on its login.
        modelGuard?.stop();
        await whenSessionRecordFree(() =>
            closeSessionRecord({ id: sessionId, reason: "exited", expectedKeyHash: keyHash })
        );
    }

    process.exit(code);
}

function collect(value: string, previous: string[]): string[] {
    return [...previous, value];
}

export function registerCodexCommand(program: Command): void {
    program
        .command("codex [account]")
        .description(
            "Claude Code with its main loop on a Codex model through ai-proxy: Claude-side calls and the opus subagent " +
                "on a Claude account, one subagent per Codex model, a session record with its own key. [account] is a " +
                "Codex proxy account, the login one bills, or auto (default). Args after -- go to claude."
        )
        .option("-m, --model <model>", `Codex model: ${SESSION_MODEL_ALIASES.join(", ")} (default sol) or a catalog id`)
        .option("-e, --effort <effort>", "Effort the model has (default high); /effort in Claude Code changes it later")
        .option("--claude <account>", "Claude proxy account or login, auto (default), or none")
        .option("--grok <account>", "Grok proxy account or login, or auto; grok/<model> ids then work in the session")
        .option("-c, --compact <percent>", "Compact at this percent of the usable window (default: the model's)")
        .option(
            "--isolated",
            `Own Claude Code config folder under ${claudeCodexConfigRoot()}, agent files written there`
        )
        .option("--allow-metered <account>", "Allow an account billed per token (repeatable)", collect, [])
        .option("-r, --resume [query]", "Resume a session: an id or a search query (bare: the picker)")
        .option("--no-start", "Fail if ai-proxy is not running instead of starting it")
        .option("--port <port>", "Use the ai-proxy on this port instead of the configured one (never started for you)")
        .allowExcessArguments(true)
        .action(async (account: string | undefined, opts: CodexSessionOptions, command: Command) => {
            const operands = command.args;
            const named = account?.startsWith("-") ? undefined : account;
            const passthrough = named === undefined ? operands : operands.slice(1);
            await runCodexSession(named, opts, passthrough);
        });
}
