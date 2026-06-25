import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { logger } from "@app/logger";
import {
    type ResolvedGithubCopilotGhoToken,
    type ResolveGithubCopilotGhoTokenOptions,
    resolveGithubCopilotGhoToken,
} from "@app/utils/ai/github-copilot/copilot-cli-auth";
import { githubApi } from "@app/utils/ai/github-copilot/github-api";
import { buildCopilotRequestHeaders } from "@app/utils/ai/github-copilot/headers";
import {
    COPILOT_INDIVIDUAL_API,
    copilotGhoTokenAuthKey,
    copilotSessionCachePath,
    githubTokenPath,
} from "@app/utils/ai/github-copilot/paths";
import type { CopilotSessionCache, CopilotTokenResponse } from "@app/utils/ai/github-copilot/types";
import { SafeJSON } from "@app/utils/json";
import { readTokenFile } from "@app/utils/oauth/storage";
import { getAuthSecret, migrateFileToAuthStorage } from "@app/utils/storage";

export { resolveGithubCopilotGhoToken } from "@app/utils/ai/github-copilot/copilot-cli-auth";
export type { ResolvedGithubCopilotGhoToken, ResolveGithubCopilotGhoTokenOptions };

const REFRESH_BUFFER_MS = 60_000;

export function getBaseUrlFromCopilotToken(token: string, fallback = COPILOT_INDIVIDUAL_API): string {
    const match = token.match(/proxy-ep=([^;]+)/);
    if (!match) {
        return fallback;
    }

    const apiHost = match[1].replace(/^proxy\./, "api.");
    return `https://${apiHost}`;
}

function readSessionCache(dataDir: string): CopilotSessionCache | null {
    const path = copilotSessionCachePath(dataDir);

    if (!existsSync(path)) {
        return null;
    }

    try {
        return SafeJSON.parse(readFileSync(path, "utf-8")) as CopilotSessionCache;
    } catch (err) {
        logger.debug({ err, path }, "github-copilot: session cache parse failed");
        return null;
    }
}

function writeSessionCache(dataDir: string, cache: CopilotSessionCache): void {
    const path = copilotSessionCachePath(dataDir);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${SafeJSON.stringify(cache, null, 2)}\n`, "utf-8");
}

export function clearSessionCache(dataDir: string): void {
    const path = copilotSessionCachePath(dataDir);

    if (existsSync(path)) {
        unlinkSync(path);
    }
}

export async function readGithubToken(dataDir: string): Promise<string | null> {
    const key = copilotGhoTokenAuthKey(dataDir);
    const stored = await getAuthSecret(key);
    if (stored) {
        return stored;
    }

    const legacyPath = githubTokenPath(dataDir);
    const legacy = readTokenFile(legacyPath);
    if (!legacy) {
        return null;
    }

    const migration = await migrateFileToAuthStorage(key, legacyPath);
    return migration.value ?? legacy;
}

export async function fetchCopilotSessionToken(ghoToken: string): Promise<CopilotTokenResponse> {
    const raw = await githubApi.post<CopilotTokenResponse>("copilot_internal/v2/token", undefined, {
        headers: {
            Accept: "application/json",
            Authorization: `token ${ghoToken}`,
            ...buildCopilotRequestHeaders([]),
        },
    });

    if (!raw.token || !raw.expires_at) {
        throw new Error("Invalid Copilot token response");
    }

    return raw;
}

export async function getCopilotSession(
    dataDir: string,
    options?: Pick<ResolveGithubCopilotGhoTokenOptions, "allowKeychain">
): Promise<CopilotSessionCache> {
    const cached = readSessionCache(dataDir);
    const now = Date.now();

    if (cached && cached.expiresAtMs - REFRESH_BUFFER_MS > now) {
        return cached;
    }

    const resolved = await resolveGithubCopilotGhoToken({
        dataDir,
        allowKeychain: options?.allowKeychain ?? false,
    });
    const gho = resolved?.token;
    if (!gho) {
        throw new Error("No GitHub token found");
    }

    const tokenResponse = await fetchCopilotSessionToken(gho);
    const apiBaseUrl = getBaseUrlFromCopilotToken(tokenResponse.token);
    const expiresAtMs = tokenResponse.expires_at * 1000;

    const session: CopilotSessionCache = {
        token: tokenResponse.token,
        expiresAtMs,
        apiBaseUrl,
        refreshedAt: new Date().toISOString(),
    };

    writeSessionCache(dataDir, session);
    return session;
}

export async function fetchGithubUserLogin(ghoToken: string): Promise<string | null> {
    try {
        const raw = await githubApi.get<{ login?: string }>("user", {
            headers: {
                Authorization: `Bearer ${ghoToken}`,
            },
        });

        return raw.login ?? null;
    } catch (err) {
        logger.debug({ err }, "github-copilot: failed to fetch GitHub user login");
        return null;
    }
}
