import { AIConfig } from "@genesiscz/utils/ai/AIConfig";
import { AiConfigStore } from "@genesiscz/utils/ai/config/AiConfigStore";
import type { AccountEntry } from "@genesiscz/utils/ai/config/schema";
import { extractExpiry, resolveCodexAccountToken } from "@genesiscz/utils/ai/openai/codex-auth";
import { resolveAccountToken } from "@genesiscz/utils/claude/subscription-auth";
import { longLivedTokenUsable } from "@genesiscz/utils/claude/token-verify";
import { logger } from "@genesiscz/utils/logger";
import { type Approver, appApprover } from "./approve";
import { describeClient, type ProcessLookup } from "./client-identity";
import { appendAudit, findGrant, rememberGrant } from "./grants";
import {
    type ClientIdentity,
    GateDeniedError,
    type GateProvider,
    type GateRequest,
    type GateResult,
    type TokenKind,
} from "./types";

const { log } = logger.scoped("ai-gate");

export interface ResolvedAccessToken {
    accessToken: string;
    expiresAt: number | null;
    kind: TokenKind;
}

/**
 * The one call that spends a credential: it may refresh, because a gate request is real use,
 * not a diagnosis. Tests inject a spy here and make it throw on a denied path.
 */
export type TokenResolver = (provider: GateProvider, account: AccountEntry) => Promise<ResolvedAccessToken>;

/** Which kind of token the account can hand out, decided BEFORE the window so it can say so. */
export type TokenKindResolver = (provider: GateProvider, account: AccountEntry) => Promise<TokenKind>;

async function longLivedFor(account: AccountEntry): Promise<{ token: string; expiresAt: number | null } | null> {
    const tokens = (await AIConfig.load()).getAccount(account.name)?.tokens;

    if (!tokens?.longLivedToken || !longLivedTokenUsable(tokens)) {
        return null;
    }

    return { token: tokens.longLivedToken, expiresAt: tokens.longLivedTokenExpiresAt ?? null };
}

/**
 * Anthropic: the long-lived token (`tools claude login-long`) is the one worth sharing. An OAuth
 * access token is revoked the moment ANY process refreshes the pair (Claude Code, the proxy, a
 * warmup), so a copy handed to another app dies without warning; the long-lived token is what
 * `tools claude run <account>` gives Claude Code, and it survives refreshes. The access token is
 * only the fallback for an account that has no long-lived token yet.
 */
export const providerTokenKind: TokenKindResolver = async (provider, account) => {
    if (provider !== "anthropic-sub") {
        return "access";
    }

    return (await longLivedFor(account)) ? "long-lived" : "access";
};

export const providerTokenResolver: TokenResolver = async (provider, account) => {
    if (provider === "anthropic-sub") {
        const longLived = await longLivedFor(account);

        if (longLived) {
            return { accessToken: longLived.token, expiresAt: longLived.expiresAt, kind: "long-lived" };
        }

        log.warn({ account: account.name }, "no long-lived token, handing out the OAuth access token instead");
        const resolved = await resolveAccountToken(account.name);
        return { accessToken: resolved.token, expiresAt: resolved.account.expiresAt ?? null, kind: "access" };
    }

    // The JWT carries its own `exp`, so the holder can keep the token until then instead of
    // asking again on a timer (an "allow once" grant would otherwise open a window per timer).
    const resolved = await resolveCodexAccountToken(account.name);
    return { accessToken: resolved.token, expiresAt: extractExpiry(resolved.token) ?? null, kind: "access" };
};

export interface GateDeps {
    approve?: Approver;
    resolveToken?: TokenResolver;
    tokenKind?: TokenKindResolver;
    lookup?: ProcessLookup;
    /** The process handling the request; the client pid must be one of its ancestors. */
    selfPid?: number;
    loadAccounts?: () => Promise<AccountEntry[]>;
    now?: () => number;
}

async function defaultLoadAccounts(): Promise<AccountEntry[]> {
    // A read-only snapshot: the lookup must not run migrations or rotate anything. The token
    // resolver below opens its own writable store when a refresh is really needed.
    const store = await AiConfigStore.readOnly();
    return store.accounts();
}

function findAccount(accounts: AccountEntry[], selector: string): AccountEntry | undefined {
    return accounts.find((entry) => entry.id === selector) ?? accounts.find((entry) => entry.name === selector);
}

function auditClient(identity: ClientIdentity) {
    return {
        name: identity.name,
        pid: identity.pid,
        executable: identity.executable,
        cwd: identity.cwd,
        verified: identity.verified,
    };
}

/**
 * Hand one token to an asking process, after Martin approves it in the app window.
 *
 * Order matters: the account is checked BEFORE any window is shown, so a typo never costs a
 * Touch ID; the grant file is checked before the window, so a remembered client is not asked
 * twice; and the token is resolved only AFTER an allow, so a deny can never reach the refresh.
 *
 * Identity: a running pid that is NOT an ancestor of this process is a lie (a bystander naming
 * another app's pid to wear its name in the window and pick up its remembered grant) and is
 * refused outright. A pid that is absent or not running is shown as unverified: it can be approved
 * once, but such a grant is never remembered and never matches a remembered one, because the
 * name is the only thing it proves.
 */
export async function requestAccountAccess(request: GateRequest, deps: GateDeps = {}): Promise<GateResult> {
    const now = deps.now ?? Date.now;
    const approve = deps.approve ?? appApprover;
    const resolveToken = deps.resolveToken ?? providerTokenResolver;
    const tokenKindOf = deps.tokenKind ?? providerTokenKind;
    const identity = describeClient(request.client, deps.lookup, deps.selfPid);
    const accounts = await (deps.loadAccounts ?? defaultLoadAccounts)();
    const account = findAccount(accounts, request.account);
    const audit = (event: "denied" | "prompted" | "allowed" | "remembered", detail?: string) =>
        appendAudit({
            at: new Date(now()).toISOString(),
            event,
            client: auditClient(identity),
            provider: request.provider,
            account: account?.name ?? request.account,
            ...(detail ? { detail } : {}),
        });

    if (!account) {
        await audit("denied", "unknown account");
        throw new GateDeniedError(
            "unknown_account",
            `No AI account named "${request.account}" (tools ai accounts list).`
        );
    }

    if (account.provider !== request.provider) {
        await audit("denied", `account is ${account.provider}`);
        throw new GateDeniedError(
            "provider_mismatch",
            `Account "${account.name}" is ${account.provider}, not ${request.provider}.`
        );
    }

    if (!account.enabled) {
        await audit("denied", "account disabled");
        throw new GateDeniedError("disabled_account", `Account "${account.name}" is disabled.`);
    }

    if (identity.executable !== null && !identity.isAncestor) {
        await audit("denied", "pid is not an ancestor of the gate process");
        throw new GateDeniedError(
            "foreign_pid",
            `pid ${identity.pid} is running but did not start this request; the gate only serves the process that spawned it.`
        );
    }

    if (identity.isAncestor && !identity.verified) {
        log.warn(
            { client: identity.name, pid: identity.pid, executable: identity.executable },
            "client is a real ancestor but its binary or script could not be established: allow once at most"
        );
    }

    const accountRef = { id: account.id, name: account.name, ...(account.label ? { label: account.label } : {}) };
    const tokenKind = await tokenKindOf(request.provider, account);
    const remembered = identity.verified ? findGrant(identity, request.provider, account.id, now()) : undefined;
    let grantedUntil: number | null = null;
    let prompted = false;

    if (remembered) {
        grantedUntil = remembered.until;
        await audit("remembered", `until ${new Date(remembered.until).toISOString()}`);
    } else {
        prompted = true;
        await audit("prompted", tokenKind);
        const decision = await approve({
            client: identity,
            provider: request.provider,
            account: accountRef,
            tokenKind,
        });

        if (decision.decision !== "allow") {
            await audit("denied", decision.reason);
            throw new GateDeniedError("denied", `Access to "${account.name}" was denied: ${decision.reason}`);
        }

        await audit("allowed", `${decision.method}, remember ${decision.rememberSeconds}s, ${tokenKind}`);

        if (decision.rememberSeconds > 0 && !identity.verified) {
            log.warn({ client: identity.name }, "unverified client: allowed once, not remembered");
        }

        if (decision.rememberSeconds > 0 && identity.verified) {
            grantedUntil = now() + decision.rememberSeconds * 1000;
            await rememberGrant({
                key: identity.key,
                clientName: identity.name,
                executable: identity.executable,
                script: identity.script,
                provider: request.provider,
                accountId: account.id,
                accountName: account.name,
                grantedAt: now(),
                until: grantedUntil,
                method: decision.method,
            });
        }
    }

    const token = await resolveToken(request.provider, account);

    return {
        provider: request.provider,
        account: accountRef,
        accessToken: token.accessToken,
        tokenKind: token.kind,
        expiresAt: token.expiresAt,
        grantedUntil,
        prompted,
    };
}
