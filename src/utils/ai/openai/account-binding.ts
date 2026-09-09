import { join } from "node:path";
import { AiConfigStore } from "@genesiscz/utils/ai/config/AiConfigStore";
import { vaultPathFor } from "@genesiscz/utils/ai/config/migrations/2026-08-secretsToVault";
import type { AccountEntry } from "@genesiscz/utils/ai/config/schema";
import {
    type CodexTokens,
    codexOAuth,
    extractAccountId,
    readCodexAuthJson,
} from "@genesiscz/utils/ai/openai/codex-auth";
import { masterKey, resolveSecret, secrets } from "@genesiscz/utils/security";
import { NETWORKED_LOCK_WAIT_MS } from "@genesiscz/utils/storage/file-lock";

function requireAccount(account: AccountEntry | undefined): AccountEntry {
    if (!account?.enabled || account.provider !== "openai-sub") {
        throw new Error("Selected Codex account was not found, is disabled, or is not an OpenAI subscription");
    }

    return account;
}

function nativeAuthReference(account: AccountEntry): string | undefined {
    return (
        account.credentials.authFile ||
        (!account.credentials.accessToken && account.credentials.dataDir
            ? join(account.credentials.dataDir, "auth.json")
            : undefined)
    );
}

export interface CodexAccountTokens {
    accessToken: string;
    chatgptAccountId: string;
    chatgptPlanType?: string;
}

/** A process keeps the immutable account ID even if the account is renamed. */
export class CodexAccountBinding {
    private lastAccessToken?: string;
    private constructor(
        readonly accountId: string,
        readonly name: string,
        private workspaceId: string | undefined,
        private readonly allowRefresh: boolean
    ) {}

    /**
     * `allowRefresh` is required on purpose. An OpenAI refresh token is single use, so a caller
     * that forgets the flag must not silently get the spending path: every call site has to say
     * whether it is launching a real session (true) or only reporting on one (false).
     */
    static async create(selector: string, options: { allowRefresh: boolean }): Promise<CodexAccountBinding> {
        const store = await (options.allowRefresh ? AiConfigStore.load() : AiConfigStore.readOnly());
        const matched = store.accountMatching(selector, "openai-sub");

        if (!matched) {
            const names = store.accounts({ provider: "openai-sub", enabled: true }).map((entry) => entry.name);
            throw new Error(
                `No Codex account matches "${selector}". Enabled OpenAI subscription accounts: ${names.join(", ") || "none"} (tools ai accounts list).`
            );
        }

        const account = requireAccount(matched);
        return new CodexAccountBinding(account.id, account.name, account.accountUuid, options.allowRefresh);
    }

    async authenticate(client: { request<T>(method: string, params?: unknown): Promise<T> }): Promise<void> {
        const tokens = await this.tokens();
        const result = await client.request<{ type: string }>("account/login/start", {
            type: "chatgptAuthTokens",
            ...tokens,
        });
        if (result.type !== "chatgptAuthTokens") {
            throw new Error("Codex did not accept external subscription authentication");
        }
    }

    async tokens(options: { refresh?: boolean; forceRefresh?: boolean } = {}): Promise<CodexAccountTokens> {
        return this.resolve(options.forceRefresh === true, options.refresh !== false && this.allowRefresh);
    }

    async refresh(previousAccountId: string | null): Promise<CodexAccountTokens> {
        if (!this.allowRefresh) {
            throw new Error("Codex token refresh is disabled for diagnosis");
        }
        if (previousAccountId && previousAccountId !== this.workspaceId) {
            throw new Error("Codex requested refresh for a different account");
        }

        return this.resolve(true);
    }

    private async resolve(force: boolean, allowRefresh = true): Promise<CodexAccountTokens> {
        const store = await (allowRefresh ? AiConfigStore.load() : AiConfigStore.readOnly());
        const account = requireAccount(store.account(this.accountId));
        const reference = nativeAuthReference(account);
        const tokens = reference ? await readCodexAuthJson(reference) : await this.storedTokens(account);
        if (tokens) {
            this.checkIdentity(account, tokens);
        }

        const needsRefresh =
            tokens &&
            (codexOAuth.needsRefresh(tokens.expiresAt) ||
                (force && (!this.lastAccessToken || tokens.accessToken === this.lastAccessToken)));
        if (allowRefresh && !reference && needsRefresh) {
            return store.withLock(async (data) => {
                const current = requireAccount(data.accounts.find((entry) => entry.id === this.accountId));
                if (nativeAuthReference(current)) {
                    throw new Error("Codex credential ownership changed during refresh");
                }

                const latest = await this.storedTokens(current);
                this.checkIdentity(current, latest);
                if (!codexOAuth.needsRefresh(latest.expiresAt) && latest.accessToken !== tokens.accessToken) {
                    return this.accept(current, latest);
                }

                if (!latest.refreshToken) {
                    throw new Error("No refresh token; use tools codex login <account> for a new managed grant");
                }

                // Legacy plaintext grants must not be spent before vault encryption is available.
                await masterKey();
                let rotated: CodexTokens;
                try {
                    rotated = await codexOAuth.refresh(latest.refreshToken);
                } catch {
                    // Provider errors can contain credentials. Never send their text to clients or logs.
                    throw new Error("Codex token refresh failed; re-login with tools codex login <account>");
                }

                this.checkIdentity(current, rotated);
                const vault = await secrets();
                current.credentials.accessToken = await vault.set(
                    vaultPathFor(current.id, "accessToken"),
                    rotated.accessToken
                );
                current.credentials.refreshToken = await vault.set(
                    vaultPathFor(current.id, "refreshToken"),
                    rotated.refreshToken
                );
                current.credentials.expiresAt = rotated.expiresAt;
                return this.accept(current, rotated);
            }, NETWORKED_LOCK_WAIT_MS);
        }

        if (force && (!this.lastAccessToken || tokens?.accessToken === this.lastAccessToken)) {
            throw new Error(
                "The CLI-owned token has not changed. Use tools codex login <account> for a separate managed grant"
            );
        }

        return this.accept(account, tokens);
    }

    private async storedTokens(account: AccountEntry): Promise<CodexTokens> {
        return {
            accessToken: (await resolveSecret(account.credentials.accessToken)) ?? "",
            refreshToken: (await resolveSecret(account.credentials.refreshToken)) ?? "",
            expiresAt: account.credentials.expiresAt ?? 0,
            accountId: account.accountUuid,
        };
    }

    private checkIdentity(account: AccountEntry, tokens: CodexTokens | null): string {
        const workspaceId = tokens ? extractAccountId(tokens.accessToken) : undefined;
        if (!tokens?.accessToken || !workspaceId || (tokens.accountId && tokens.accountId !== workspaceId)) {
            throw new Error("Codex account has no usable subscription credentials");
        }

        if (
            (this.workspaceId && workspaceId !== this.workspaceId) ||
            (account.accountUuid && workspaceId !== account.accountUuid)
        ) {
            throw new Error("Codex credential identity changed; refusing to switch the running account");
        }

        return workspaceId;
    }

    private accept(account: AccountEntry, tokens: CodexTokens | null): CodexAccountTokens {
        const workspaceId = this.checkIdentity(account, tokens);
        if (!tokens?.expiresAt || tokens.expiresAt <= Date.now()) {
            throw new Error("Codex credentials expired. Re-login with tools codex login <account> for managed refresh");
        }

        this.workspaceId = workspaceId;
        this.lastAccessToken = tokens.accessToken;
        return { accessToken: tokens.accessToken, chatgptAccountId: workspaceId };
    }
}
