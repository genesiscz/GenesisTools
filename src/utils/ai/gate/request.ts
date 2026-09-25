import { AIConfig } from "@genesiscz/utils/ai/AIConfig";
import { AiConfigStore } from "@genesiscz/utils/ai/config/AiConfigStore";
import type { AccountEntry } from "@genesiscz/utils/ai/config/schema";
import { GATE_ONLY_TAG, isGateOnly } from "@genesiscz/utils/ai/config/selectors";
import { extractExpiry, resolveCodexAccountToken } from "@genesiscz/utils/ai/openai/codex-auth";
import { CredentialUnavailableError, resolveCredential } from "@genesiscz/utils/ai/providers/credentials";
import type { CredentialSpec } from "@genesiscz/utils/ai/providers/plugin-types";
import { resolveAccountToken } from "@genesiscz/utils/claude/subscription-auth";
import { longLivedTokenUsable } from "@genesiscz/utils/claude/token-verify";
import { logger } from "@genesiscz/utils/logger";
import { type Approver, appApprover } from "./approve";
import { describeClient, type ProcessLookup } from "./client-identity";
import { appendAudit, findGrant, rememberGrant } from "./grants";
import {
    type ClientIdentity,
    type GateApiKeyProvider,
    GateDeniedError,
    type GateProvider,
    type GateRequest,
    type GateResult,
    isApiKeyGateProvider,
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
 *
 * `kind` is the kind the approval covered (the window said so, or the remembered grant recorded
 * it). The resolver returns exactly that kind or throws: a long-lived token removed during the
 * prompt must not turn into a silently shared OAuth access token, nor the other way round.
 */
export type TokenResolver = (
    provider: GateProvider,
    account: AccountEntry,
    kind: TokenKind
) => Promise<ResolvedAccessToken>;

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
    if (isApiKeyGateProvider(provider)) {
        return "api-key";
    }

    if (provider !== "anthropic-sub") {
        return "access";
    }

    return (await longLivedFor(account)) ? "long-lived" : "access";
};

/** The variable a store command pipes in, so the printed line runs as written in a shell that exports it. */
const API_KEY_ENV: Record<GateApiKeyProvider, string> = { xai: "XAI_API_KEY", openai: "OPENAI_API_KEY" };

/** A stored key only: the credential chokepoint with the environment switched off. */
const STORED_API_KEY_SPEC: CredentialSpec = { fields: ["apiKey"], envKeys: [], required: ["apiKey"] };

function hasStoredApiKey(account: AccountEntry): boolean {
    return account.credentials.apiKey !== undefined;
}

function addGateAccountCommand(provider: GateApiKeyProvider): string {
    return `printf '%s' "$${API_KEY_ENV[provider]}" | tools ai config account add --provider ${provider} --name ${provider}-gate --tag ${GATE_ONLY_TAG} --api-key-stdin`;
}

/**
 * The account's STORED key, read in this process (the vault opens under the gate's own launcher
 * name). `useEnvApiKey` is forced off: a variable in the gate process's environment is not the
 * account's key, and the gate would otherwise hand out whatever its own environment happened to hold.
 */
async function storedApiKey(account: AccountEntry): Promise<string> {
    try {
        const resolved = await resolveCredential({ ...account, useEnvApiKey: false }, STORED_API_KEY_SPEC);

        if (!resolved.apiKey) {
            throw new CredentialUnavailableError(account.name, account.provider, "no api key");
        }

        return resolved.apiKey;
    } catch (error) {
        if (!(error instanceof CredentialUnavailableError)) {
            throw error;
        }

        throw new GateDeniedError(
            "no_stored_key",
            `The API key of "${account.name}" could not be read from the vault: ${error.message}`
        );
    }
}

export const providerTokenResolver: TokenResolver = async (provider, account, kind) => {
    if (kind === "api-key" || isApiKeyGateProvider(provider)) {
        if (kind !== "api-key" || !isApiKeyGateProvider(provider)) {
            throw new GateDeniedError(
                "token_kind_changed",
                `"${account.name}" (${provider}) cannot hand out a ${kind} token; ask again.`
            );
        }

        return { accessToken: await storedApiKey(account), expiresAt: null, kind: "api-key" };
    }

    if (kind === "long-lived") {
        const longLived = provider === "anthropic-sub" ? await longLivedFor(account) : null;

        if (!longLived) {
            throw new GateDeniedError(
                "token_kind_changed",
                `The long-lived token approved for "${account.name}" is no longer usable; ask again to approve what is there now.`
            );
        }

        return { accessToken: longLived.token, expiresAt: longLived.expiresAt, kind: "long-lived" };
    }

    if (provider === "anthropic-sub") {
        log.warn({ account: account.name }, "approved for an OAuth access token, handing that out");
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
    // resolver below opens its own writable store when a refresh is really needed. No filter, so
    // `gate-only` accounts are in: this door is the one they exist for.
    const store = await AiConfigStore.readOnly();
    return store.accounts();
}

function findAccount(accounts: AccountEntry[], selector: string): AccountEntry | undefined {
    return accounts.find((entry) => entry.id === selector) ?? accounts.find((entry) => entry.name === selector);
}

/** No account named: an enabled one of the provider that stores a key, a `gate-only` one first. */
function defaultApiKeyAccount(accounts: AccountEntry[], provider: GateApiKeyProvider): AccountEntry | undefined {
    const stored = accounts.filter((entry) => entry.provider === provider && entry.enabled && hasStoredApiKey(entry));
    return stored.find(isGateOnly) ?? stored[0];
}

function unknownAccountMessage(request: GateRequest): string {
    if (request.account !== undefined) {
        return `No AI account named "${request.account}" (tools ai accounts list).`;
    }

    if (isApiKeyGateProvider(request.provider)) {
        return `No enabled ${request.provider} account stores an API key. Add one for the gate with: ${addGateAccountCommand(request.provider)}`;
    }

    return `Name the ${request.provider} account with --account (tools ai accounts list).`;
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
 * Hand one token (or, for an API-key provider, the account's stored API key) to an asking process,
 * after the user approves it in the app window.
 *
 * Order matters: the account is checked BEFORE any window is shown, so a typo or an API-key account
 * with nothing stored never costs a Touch ID; the grant file is checked before the window, so a
 * remembered client is not asked twice; and the token is resolved only AFTER an allow, so a deny can
 * never reach the refresh or the vault.
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
    const account =
        request.account !== undefined
            ? findAccount(accounts, request.account)
            : isApiKeyGateProvider(request.provider)
              ? defaultApiKeyAccount(accounts, request.provider)
              : undefined;
    const audit = (event: "denied" | "prompted" | "allowed" | "remembered", detail?: string) =>
        appendAudit({
            at: new Date(now()).toISOString(),
            event,
            client: auditClient(identity),
            provider: request.provider,
            account: account?.name ?? request.account ?? "(none named)",
            ...(detail ? { detail } : {}),
        });

    if (!account) {
        await audit("denied", "unknown account");
        throw new GateDeniedError("unknown_account", unknownAccountMessage(request));
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

    if (isApiKeyGateProvider(request.provider) && !hasStoredApiKey(account)) {
        await audit("denied", "no stored key");
        throw new GateDeniedError(
            "no_stored_key",
            `Account "${account.name}" stores no API key, and the gate never hands out an environment variable. Add an account for the gate with: ${addGateAccountCommand(request.provider)}`
        );
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
    const remembered = identity.verified
        ? findGrant({ identity, provider: request.provider, accountId: account.id, tokenKind, now: now() })
        : undefined;
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
                tokenKind,
            });
        }
    }

    const token = await resolveToken(request.provider, account, tokenKind).catch(async (error: unknown) => {
        if (error instanceof GateDeniedError) {
            await audit("denied", error.message);
        }

        throw error;
    });

    if (token.kind !== tokenKind) {
        await audit("denied", `approved ${tokenKind}, resolver returned ${token.kind}`);
        throw new GateDeniedError(
            "token_kind_changed",
            `Access to "${account.name}" was approved for a ${tokenKind} token, but a ${token.kind} token came back; ask again.`
        );
    }

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
