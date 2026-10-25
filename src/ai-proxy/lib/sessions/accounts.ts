/**
 * Which account a session agent runs on (❓ DECISION 1 a, Martin 2026-10-25): a login, which the proxy turns into an
 * account in memory, or a configured proxy account named by the user (the legacy Codex account that reads
 * ~/.codex/auth.json keeps working that way). Shared by the launcher (`tools claude codex`) and the manual switch
 * (`tools ai-proxy session <id> use`).
 */
import { resolveProxyAccountEntry } from "@app/ai-proxy/lib/account-refs";
import { SUBSCRIPTION_PROVIDER_TYPES } from "@app/ai-proxy/lib/clients";
import { SESSION_ACCOUNT_FIELD, SESSION_LOGIN_FIELD, type SessionAgent } from "@app/ai-proxy/lib/sessions/records";
import { agentOf } from "@app/ai-proxy/lib/sessions/view";
import type { AiProxyAccountConfig } from "@app/ai-proxy/lib/types";
import type { AiConfigStore } from "@genesiscz/utils/ai/config/AiConfigStore";

export type Resolved<T> = T | { error: string };

export function isError<T>(value: Resolved<T>): value is { error: string } {
    return typeof value === "object" && value !== null && "error" in value;
}

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

/** The AI-config provider of each agent's logins. */
const LOGIN_PROVIDER: Record<SessionAgent, string> = {
    codex: "openai-sub",
    claude: "anthropic-sub",
    grok: "grok-sub",
};

export function agentLogins(store: AiConfigStore, agent: SessionAgent): SessionLogin[] {
    return store
        .accounts({ provider: LOGIN_PROVIDER[agent], enabled: true })
        .map((account) => ({ id: account.id, name: account.name }));
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

/** The login a choice bills: its own, or the one its configured proxy account is linked to. */
export function choiceLogin(choice: SessionAccountChoice, store: AiConfigStore): string | undefined {
    return (
        choice.login ?? (choice.proxyAccount ? resolveProxyAccountEntry(choice.proxyAccount, store)?.name : undefined)
    );
}

/** The record fields for one agent: the configured proxy account and the login, whichever the choice has. */
export function recordFields(
    agent: SessionAgent,
    choice: SessionAccountChoice | undefined,
    store: AiConfigStore
): Partial<Record<(typeof SESSION_ACCOUNT_FIELD)[SessionAgent] | (typeof SESSION_LOGIN_FIELD)[SessionAgent], string>> {
    if (!choice) {
        return {};
    }

    const login = choiceLogin(choice, store);
    return {
        ...(choice.proxyAccount ? { [SESSION_ACCOUNT_FIELD[agent]]: choice.proxyAccount.name } : {}),
        ...(login ? { [SESSION_LOGIN_FIELD[agent]]: login } : {}),
    };
}
