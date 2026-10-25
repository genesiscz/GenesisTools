/**
 * The pure parts of `tools claude codex` (P3, P6, P7, P12, P13, P15): the model and effort from the Codex catalog, the
 * account for each agent, Claude Code's environment and arguments. The command (`commands/codex.ts`) does the I/O.
 */
import { SUBSCRIPTION_PROVIDER_TYPES } from "@app/ai-proxy/lib/clients";
import type { SessionAgent } from "@app/ai-proxy/lib/sessions/records";
import { agentOf } from "@app/ai-proxy/lib/sessions/view";
import type { AiProxyAccountConfig } from "@app/ai-proxy/lib/types";
import { CLAUDE_MODELS } from "@app/claude/lib/models";
import { type CodexModelInfo, describeCodexEfforts, resolveCodexEffort } from "@genesiscz/utils/ai/openai/codex-models";
import { resolveOpenAiSubModel } from "@genesiscz/utils/ai/openai/sub-models";
import type { AccountUsageSnapshot } from "@genesiscz/utils/ai/providers/account-features";
import { pickRanked, type RankedAccount, rankAccounts } from "@genesiscz/utils/ai/usage/account-rank";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { SafeJSON } from "@genesiscz/utils/json";

/** The model aliases P3 names; any catalog id works too. */
export const SESSION_MODEL_ALIASES = ["sol", "sol6", "astra", "luna"] as const;
export const DEFAULT_SESSION_MODEL = "sol";
/** switcheroo's `ccx` runs its main loop at high unless asked, and the generated subagents run at high. */
export const DEFAULT_SESSION_EFFORT = "high";

export type Resolved<T> = T | { error: string };

export function isError<T>(value: Resolved<T>): value is { error: string } {
    return typeof value === "object" && value !== null && "error" in value;
}

export function resolveSessionModel(
    spec: string | undefined,
    codexModel: (slug: string) => CodexModelInfo | undefined
): Resolved<{ slug: string; info: CodexModelInfo }> {
    const slug = resolveOpenAiSubModel(spec ?? DEFAULT_SESSION_MODEL);
    const info = codexModel(slug);

    if (!info) {
        return {
            error: `Unknown Codex model "${spec}". Use ${SESSION_MODEL_ALIASES.join(", ")} or a catalog id (${toolCommand("codex models")} lists them).`,
        };
    }

    return { slug, info };
}

/** The effort Claude Code gets as `--effort`: refused when the model lacks it (P13); `ultra` resolves per model. */
export function resolveSessionEffort(info: CodexModelInfo, effort: string | undefined): Resolved<{ effort: string }> {
    const resolved = resolveCodexEffort(info, effort ?? DEFAULT_SESSION_EFFORT);

    if (!resolved.ok) {
        return { error: `${resolved.message} (${describeCodexEfforts(info)})` };
    }

    return { effort: resolved.effort };
}

/**
 * One agent's account for the session (❓ DECISION 1 a, Martin 2026-10-25): a login, which the proxy turns into an
 * account in memory, or a configured proxy account named on the command line (the legacy Codex account that reads
 * ~/.codex/auth.json keeps working that way).
 */
export interface SessionAccountChoice {
    login?: string;
    proxyAccount?: AiProxyAccountConfig;
    /** The proxy account's name or the login: what the user typed and sees. */
    label: string;
    how: "named" | "auto" | "only";
    /** The ranking's reason for an `auto` pick. */
    why?: string;
    runnerUp?: string;
    /** Billed per token: needs `--allow-metered <account>` or a yes (P6). Only a configured account can be. */
    metered: boolean;
}

/** A login of one agent: an AI-config account (`tools codex`, `tools claude`, `tools grok`). */
export interface SessionLogin {
    id: string;
    name: string;
}

/** The enabled proxy accounts an agent can run on. */
export function agentAccounts(accounts: AiProxyAccountConfig[], agent: SessionAgent): AiProxyAccountConfig[] {
    return accounts.filter((account) => account.enabled && agentOf(account.provider) === agent);
}

export function isMetered(account: AiProxyAccountConfig): boolean {
    return !SUBSCRIPTION_PROVIDER_TYPES.has(account.provider);
}

/** A named account: a configured proxy account by name first (it keeps its own settings), else a login. */
export function namedAccount(
    spec: string,
    proxyAccounts: AiProxyAccountConfig[],
    logins: SessionLogin[],
    agent: SessionAgent
): Resolved<SessionAccountChoice> {
    const proxyAccount = proxyAccounts.find((account) => account.name === spec);

    if (proxyAccount) {
        return { proxyAccount, label: spec, how: "named", metered: isMetered(proxyAccount) };
    }

    if (logins.some((login) => login.name === spec)) {
        return { login: spec, label: spec, how: "named", metered: false };
    }

    const known = [...logins.map((login) => login.name), ...proxyAccounts.map((account) => account.name)];
    return { error: `No ${agent} login or proxy account is named "${spec}" (known: ${known.join(", ") || "none"}).` };
}

/**
 * `auto` for Codex and Grok: every login of the agent ranked by its usage (`rankAccounts`) with the sessions already on
 * it. Logins are subscriptions, so a metered account is never picked. When no login has usage data at all, the one
 * configured subscription account (today the legacy Codex account) is taken; a blocked login is never guessed onto.
 */
export function autoAccount(input: {
    agent: SessionAgent;
    logins: SessionLogin[];
    snapshots: AccountUsageSnapshot[];
    /** Open sessions per login name. */
    sessions: Record<string, number>;
    /** Configured accounts `auto` may fall back on when no login has data. */
    fallback: AiProxyAccountConfig[];
    now?: Date;
}): Resolved<SessionAccountChoice & { ranked: RankedAccount[] }> {
    const byId = new Map(input.logins.map((login) => [login.id, login.name] as const));
    const snapshots = input.snapshots
        .filter((snapshot) => byId.has(snapshot.accountId))
        .map((snapshot) => ({ ...snapshot, accountName: byId.get(snapshot.accountId) ?? snapshot.accountName }));
    const ranked = rankAccounts(snapshots, { sessions: input.sessions, ...(input.now ? { now: input.now } : {}) });
    const picked = pickRanked(ranked);

    if (picked) {
        return {
            login: picked.pick.accountName,
            label: picked.pick.accountName,
            how: "auto",
            why: picked.pick.why,
            ...(picked.runnerUp ? { runnerUp: `${picked.runnerUp.accountName} (${picked.runnerUp.why})` } : {}),
            metered: false,
            ranked,
        };
    }

    const subscription = input.fallback.filter((account) => !isMetered(account));

    if (ranked.every((row) => row.tier === "no-data") && subscription.length === 1 && subscription[0]) {
        return {
            proxyAccount: subscription[0],
            label: subscription[0].name,
            how: "only",
            why: "no login has usage data; the one configured account",
            metered: false,
            ranked,
        };
    }

    const reasons = ranked.map((row) => `${row.accountName}: ${row.tier}, ${row.why}`).join("; ");
    return {
        error: `auto found no ${input.agent} login with headroom (${reasons || "no usage data"}). Name one instead.`,
    };
}

/** The Claude Code id of a Claude model by its catalog alias. */
export function claudeModelByAlias(alias: string): string | undefined {
    return CLAUDE_MODELS.find((model) => model.aliases?.includes(alias))?.id;
}

export interface SessionEnvInput {
    baseUrl: string;
    /** The session key (`gts_…`). */
    key: string;
    /** `codex/<slug>`, no effort suffix, so `/effort` works. */
    model: string;
    /** Set when the session has a Claude account. */
    claude?: { haiku: string; sonnet?: string; opus: string; subscriptionType?: string };
    /** The small-model slot without a Claude account. */
    smallCodexModel: string;
    /** Window × usable percent, plain digits. */
    maxContextTokens: number;
    compactPercent: number;
    /** `codex:<account>+claude:<account>` for `tools claude who` and the statusline. */
    accountLabel: string;
}

/**
 * Inherited values that would bill the wrong way or override the session's own settings: a first-party OAuth token
 * or an API key beats ANTHROPIC_AUTH_TOKEN and bills Anthropic directly; a forced subagent model or effort beats the
 * per-agent ones (S2); an inherited window or percent belongs to another model.
 */
const SCRUBBED_ENV = [
    "CLAUDE_CODE_OAUTH_TOKEN",
    "ANTHROPIC_API_KEY",
    "CLAUDE_CODE_SUBSCRIPTION_TYPE",
    "CLAUDE_CODE_RATE_LIMIT_TIER",
    "CLAUDE_CODE_MAX_CONTEXT_TOKENS",
    "CLAUDE_CODE_AUTO_COMPACT_WINDOW",
    "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE",
    "CLAUDE_CODE_EFFORT_LEVEL",
    "CLAUDE_CODE_SUBAGENT_MODEL",
    "CLAUDE_CODE_SUBAGENT_MODEL_FORCE",
    "ANTHROPIC_SMALL_FAST_MODEL",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL",
    "ANTHROPIC_DEFAULT_SONNET_MODEL",
    "ANTHROPIC_DEFAULT_OPUS_MODEL",
    "ANTHROPIC_DEFAULT_FABLE_MODEL",
    "ANTHROPIC_CUSTOM_MODEL_OPTION",
    "ANTHROPIC_CUSTOM_MODEL_OPTION_NAME",
    "ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION",
] as const;

export function sessionEnv(
    inherited: Record<string, string | undefined>,
    input: SessionEnvInput
): Record<string, string | undefined> {
    const env = { ...inherited };

    for (const name of SCRUBBED_ENV) {
        delete env[name];
    }

    const small = input.claude?.haiku ?? input.smallCodexModel;

    return {
        ...env,
        ANTHROPIC_BASE_URL: input.baseUrl,
        ANTHROPIC_AUTH_TOKEN: input.key,
        ANTHROPIC_MODEL: input.model,
        ANTHROPIC_DEFAULT_HAIKU_MODEL: small,
        ANTHROPIC_SMALL_FAST_MODEL: small,
        ...(input.claude?.sonnet ? { ANTHROPIC_DEFAULT_SONNET_MODEL: input.claude.sonnet } : {}),
        ...(input.claude ? { ANTHROPIC_DEFAULT_OPUS_MODEL: input.claude.opus } : {}),
        ...(input.claude?.subscriptionType ? { CLAUDE_CODE_SUBSCRIPTION_TYPE: input.claude.subscriptionType } : {}),
        CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(Math.floor(input.maxContextTokens)),
        CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(Math.floor(input.maxContextTokens)),
        CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: String(input.compactPercent),
        TOOLS_CLAUDE_ACCOUNT: `proxy:${input.accountLabel}`,
    };
}

/** A user flag after `--` that the launcher also sets: theirs wins, ours is left out. */
export function passthroughSets(passthrough: string[], flag: "--effort" | "--model"): boolean {
    return passthrough.some((arg) => arg === flag || arg.startsWith(`${flag}=`));
}

/**
 * Claude Code's arguments: the session id (new) or the resumed id, the effort, the subagents, the settings, the user's
 * own. `settingsEnv` rides in `--settings`, because Claude Code applies the `env` of ~/.claude/settings.json over the
 * process environment and only CLI settings beat it: a user-wide CLAUDE_CODE_AUTO_COMPACT_WINDOW of 700000 would let
 * a 500K Codex session fill its window before compacting. A user's own `--settings` wins and drops ours.
 */
export function sessionArgs(input: {
    sessionId: string;
    resume: boolean;
    effort: string;
    agents: string[];
    settingsEnv: Record<string, string>;
    passthrough: string[];
}): string[] {
    const ownSettings = input.passthrough.some((arg) => arg === "--settings" || arg.startsWith("--settings="));

    return [
        ...(input.resume ? ["--resume", input.sessionId] : ["--session-id", input.sessionId]),
        ...(passthroughSets(input.passthrough, "--effort") ? [] : ["--effort", input.effort]),
        ...input.agents,
        ...(ownSettings ? [] : ["--settings", SafeJSON.stringify({ env: input.settingsEnv })]),
        ...input.passthrough,
    ];
}
