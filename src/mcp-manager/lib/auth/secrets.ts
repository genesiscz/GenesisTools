import { randomBytes } from "node:crypto";
import { secrets } from "@genesiscz/utils/security";
import { withRefreshLock } from "./lock.ts";
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

export async function writeServerTokens(
    server: string,
    tokens: {
        accessToken: string;
        refreshToken?: string;
        expiresAt?: number;
        clientId?: string;
        clientSecret?: string;
    }
): Promise<void> {
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

export async function deleteServerTokens(server: string): Promise<void> {
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
