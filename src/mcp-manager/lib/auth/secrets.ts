import { randomBytes } from "node:crypto";
import { secretSnapshot, secrets } from "@genesiscz/utils/security";
import { withRefreshLock, withServerCredentialsLock } from "./lock.ts";
import { GATEWAY_CLIENT_TOKEN_PATH, secretPath } from "./paths.ts";

export async function readSecret(path: string): Promise<string | undefined> {
    const store = await secrets();

    return store.get(path);
}

export async function writeSecret(path: string, value: string): Promise<void> {
    const store = await secrets();

    await store.set(path, value);
}

export async function deleteSecret(path: string): Promise<boolean> {
    const store = await secrets();

    return store.delete(path);
}

export async function hasSecret(path: string): Promise<boolean> {
    const store = await secrets();

    return store.has(path);
}

export async function ensureGatewayClientToken(): Promise<string> {
    const existing = await readSecret(GATEWAY_CLIENT_TOKEN_PATH);

    if (existing && existing.length > 0) {
        return existing;
    }

    // Mint under the same lock the token refresh already uses. Concurrency here is
    // guaranteed by design, not hypothetical: projectServerForHarness gives Cursor one
    // `gateway stdio` process PER SERVER, and every one of them calls this on first
    // run. Unlocked, each read `undefined`, each minted its own randomBytes(32), and
    // last write won — every loser was left holding a token the gateway 401s.
    return withRefreshLock("gateway-client", async () => {
        const raced = await readSecret(GATEWAY_CLIENT_TOKEN_PATH);

        if (raced && raced.length > 0) {
            return raced;
        }

        const token = randomBytes(32).toString("base64url");
        await writeSecret(GATEWAY_CLIENT_TOKEN_PATH, token);

        return token;
    });
}

export async function rotateGatewayClientToken(): Promise<string> {
    const token = randomBytes(32).toString("base64url");
    await writeSecret(GATEWAY_CLIENT_TOKEN_PATH, token);

    return token;
}

export interface ServerTokens {
    accessToken: string;
    refreshToken?: string;
    expiresAt?: number;
    clientId?: string;
    clientSecret?: string;
}

export interface ServerTokenSnapshot {
    accessToken?: string;
    refreshToken?: string;
    expiresAt?: number;
    hasRefresh: boolean;
    clientId?: string;
    clientSecret?: string;
}

export async function readServerTokenSnapshot(
    server: string,
    options: { includeRefreshToken?: boolean; includeClient?: boolean } = {}
): Promise<ServerTokenSnapshot> {
    const snapshot = secretSnapshot();
    const expiresRaw = await snapshot.get(secretPath(server, "token-expires-at"));
    const expiresNumber = expiresRaw === undefined ? undefined : Number(expiresRaw);
    const clientId = options.includeClient ? await snapshot.get(secretPath(server, "client-id")) : undefined;
    const staticClientId = options.includeClient
        ? await snapshot.get(secretPath(server, "static-client-id"))
        : undefined;

    return {
        accessToken: await snapshot.get(secretPath(server, "access-token")),
        expiresAt: expiresNumber !== undefined && Number.isFinite(expiresNumber) ? expiresNumber : undefined,
        hasRefresh: snapshot.has(secretPath(server, "refresh-token")),
        refreshToken: options.includeRefreshToken ? await snapshot.get(secretPath(server, "refresh-token")) : undefined,
        clientId,
        // A refresh belongs to the client that obtained the grant. Only that same
        // static app may supply a rotated secret, including removing its secret.
        clientSecret: options.includeClient
            ? await snapshot.get(
                  secretPath(server, clientId && clientId === staticClientId ? "static-client-secret" : "client-secret")
              )
            : undefined,
    };
}

export interface StaticClient {
    clientId: string;
    clientSecret?: string;
}

/**
 * A pre-registered OAuth app for a server without dynamic registration (HubSpot).
 *
 * Kept apart from the `client-id` / `client-secret` slots a login writes, because a
 * logout or a fresh login clears those, and this app was typed in by hand once.
 */
export async function writeStaticClient(server: string, client: StaticClient): Promise<void> {
    await withServerCredentialsLock(server, async () => {
        const grantClientId = await readSecret(secretPath(server, "client-id"));

        if (grantClientId !== client.clientId) {
            // A different app must log in again; its predecessor's tokens cannot be reused.
            await deleteServerTokensUnlocked(server);
        }

        await writeSecret(secretPath(server, "static-client-id"), client.clientId);

        if (client.clientSecret) {
            await writeSecret(secretPath(server, "static-client-secret"), client.clientSecret);
        } else {
            await deleteSecret(secretPath(server, "static-client-secret"));
        }
    });
}

export async function readStaticClient(server: string): Promise<StaticClient | undefined> {
    const snapshot = secretSnapshot();
    const clientId = await snapshot.get(secretPath(server, "static-client-id"));

    if (!clientId) {
        return undefined;
    }

    return { clientId, clientSecret: await snapshot.get(secretPath(server, "static-client-secret")) };
}

export async function hasStaticClient(server: string): Promise<boolean> {
    return hasSecret(secretPath(server, "static-client-id"));
}

/**
 * Patch write: an omitted field is left alone. Correct for a refresh, which only ever
 * learns a new access token (and sometimes a rotated refresh token).
 */
export async function writeServerTokens(server: string, tokens: ServerTokens): Promise<void> {
    await withServerCredentialsLock(server, () => writeServerTokensUnlocked(server, tokens));
}

/** Caller must hold the server credential lifecycle lock. */
export async function writeServerTokensUnlocked(server: string, tokens: ServerTokens): Promise<void> {
    await writeSecret(secretPath(server, "access-token"), tokens.accessToken);

    if (tokens.refreshToken) {
        await writeSecret(secretPath(server, "refresh-token"), tokens.refreshToken);
    }

    if (tokens.expiresAt !== undefined) {
        await writeSecret(secretPath(server, "token-expires-at"), String(tokens.expiresAt));
    }

    if (tokens.clientId) {
        await writeSecret(secretPath(server, "client-id"), tokens.clientId);
    }

    if (tokens.clientSecret) {
        await writeSecret(secretPath(server, "client-secret"), tokens.clientSecret);
    }
}

/**
 * Replacement write: an omitted field is DELETED.
 *
 * A fresh login registers a new client, so the previous client_secret and refresh token
 * belong to a client_id that no longer exists. The patch write above kept them, and the
 * next refresh then posted last week's refresh_token and client_secret alongside this
 * week's client_id — a combination the server can only answer with invalid_client.
 */
export async function replaceServerTokens(server: string, tokens: ServerTokens): Promise<void> {
    await withServerCredentialsLock(server, () => replaceServerTokensUnlocked(server, tokens));
}

async function replaceServerTokensUnlocked(server: string, tokens: ServerTokens): Promise<void> {
    await writeSecret(secretPath(server, "access-token"), tokens.accessToken);

    const optional: Array<[string, string | undefined]> = [
        ["refresh-token", tokens.refreshToken],
        ["token-expires-at", tokens.expiresAt === undefined ? undefined : String(tokens.expiresAt)],
        ["client-id", tokens.clientId],
        ["client-secret", tokens.clientSecret],
    ];

    for (const [field, value] of optional) {
        if (value) {
            await writeSecret(secretPath(server, field), value);
            continue;
        }

        await deleteSecret(secretPath(server, field));
    }
}

export async function deleteServerTokens(server: string): Promise<void> {
    await withServerCredentialsLock(server, () => deleteServerTokensUnlocked(server));
}

async function deleteServerTokensUnlocked(server: string): Promise<void> {
    for (const field of [
        "access-token",
        "refresh-token",
        "token-expires-at",
        "client-id",
        "client-secret",
        "dcr-registration",
    ]) {
        await deleteSecret(secretPath(server, field));
    }
}

export async function readAccessToken(server: string): Promise<string | undefined> {
    return readSecret(secretPath(server, "access-token"));
}

export async function readRefreshToken(server: string): Promise<string | undefined> {
    return readSecret(secretPath(server, "refresh-token"));
}

export async function readExpiresAt(server: string): Promise<number | undefined> {
    const raw = await readSecret(secretPath(server, "token-expires-at"));

    if (!raw) {
        return undefined;
    }

    const n = Number(raw);

    return Number.isFinite(n) ? n : undefined;
}
