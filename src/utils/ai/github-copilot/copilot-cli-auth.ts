import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { logger, out } from "@app/logger";
import { copilotGhoTokenAuthKey, githubTokenPath } from "@app/utils/ai/github-copilot/paths";
import { env } from "@app/utils/env";
import { SafeJSON } from "@app/utils/json";
import { dispatchNotification } from "@app/utils/notifications";
import { readTokenFile } from "@app/utils/oauth/storage";
import { getAuthSecret, migrateFileToAuthStorage } from "@app/utils/storage";

export const COPILOT_CLI_CONFIG_PATH = join(homedir(), ".copilot", "config.json");
export const COPILOT_CLI_KEYCHAIN_SERVICE = "copilot-cli";

export type GithubCopilotTokenSource =
    | "data-dir"
    | "copilot-github-token-env"
    | "github-token-env"
    | "copilot-cli-keychain"
    | "copilot-cli-plaintext";

export interface CopilotCliLoggedInUser {
    host: string;
    login: string;
}

export interface ResolveGithubCopilotGhoTokenOptions {
    dataDir: string;
    /** When false (default), never reads macOS Keychain — avoids unprompted password dialogs. */
    allowKeychain?: boolean;
    /** When true (default), notify the user before the first keychain read in this process. */
    notifyBeforeKeychain?: boolean;
}

export interface ResolvedGithubCopilotGhoToken {
    token: string;
    source: GithubCopilotTokenSource;
    loginHint?: string;
}

const resolvedTokenCache = new Map<string, ResolvedGithubCopilotGhoToken | null>();
const keychainLookupCache = new Map<string, string | null>();
let keychainNotificationSent = false;

function trimToken(value: string | undefined | null): string | null {
    const trimmed = value?.trim();
    return trimmed ? trimmed : null;
}

export function readCopilotCliConfig(): { lastLoggedInUser?: CopilotCliLoggedInUser } | null {
    if (!existsSync(COPILOT_CLI_CONFIG_PATH)) {
        return null;
    }

    try {
        return SafeJSON.parse(readFileSync(COPILOT_CLI_CONFIG_PATH, "utf-8")) as {
            lastLoggedInUser?: CopilotCliLoggedInUser;
        };
    } catch (err) {
        logger.debug({ err, path: COPILOT_CLI_CONFIG_PATH }, "github-copilot: failed to read copilot CLI config");
        return null;
    }
}

export function copilotCliKeychainAccount(host: string, login: string): string {
    const normalizedHost = host.replace(/\/$/, "");
    return `${normalizedHost}:${login}`;
}

async function notifyBeforeKeychainAccess(login?: string): Promise<void> {
    if (keychainNotificationSent) {
        return;
    }

    keychainNotificationSent = true;

    const who = login ? ` (${login})` : "";
    const message =
        `ai-proxy will read your GitHub Copilot CLI login${who} from macOS Keychain. ` +
        "macOS may prompt you once to allow access — approve to detect your Copilot account.";

    out.log.info(message);

    try {
        await dispatchNotification({
            app: "ai-proxy",
            title: "GitHub Copilot keychain access",
            message,
        });
    } catch (err) {
        logger.debug({ err }, "github-copilot: keychain pre-notification failed");
    }
}

async function readCopilotCliKeychainToken(account: string): Promise<string | null> {
    if (keychainLookupCache.has(account)) {
        return keychainLookupCache.get(account) ?? null;
    }

    try {
        const proc = Bun.spawn({
            cmd: ["security", "find-generic-password", "-s", COPILOT_CLI_KEYCHAIN_SERVICE, "-a", account, "-w"],
            stdout: "pipe",
            stderr: "pipe",
        });

        const [stdoutText, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);

        const token = exitCode === 0 ? trimToken(stdoutText) : null;
        keychainLookupCache.set(account, token);
        return token;
    } catch {
        keychainLookupCache.set(account, null);
        return null;
    }
}

function readCopilotCliPlaintextToken(login: string): string | null {
    const candidates = [
        join(homedir(), ".copilot", "github_token"),
        join(homedir(), ".copilot", `${login}_token`),
        join(homedir(), ".copilot", "token"),
    ];

    for (const path of candidates) {
        const token = readTokenFile(path);
        if (token) {
            return token;
        }
    }

    return null;
}

function readEnvTokens(): Array<{ token: string; source: GithubCopilotTokenSource }> {
    const entries: Array<{ token: string; source: GithubCopilotTokenSource }> = [];

    const copilotEnv = trimToken(env.github.getCopilotToken());
    if (copilotEnv) {
        entries.push({ token: copilotEnv, source: "copilot-github-token-env" });
    }

    const githubEnv = trimToken(env.github.getToken());
    if (githubEnv) {
        entries.push({ token: githubEnv, source: "github-token-env" });
    }

    return entries;
}

function cacheResolved(
    dataDir: string,
    value: ResolvedGithubCopilotGhoToken | null
): ResolvedGithubCopilotGhoToken | null {
    resolvedTokenCache.set(dataDir, value);
    return value;
}

export function clearGithubCopilotTokenResolutionCache(): void {
    resolvedTokenCache.clear();
    keychainLookupCache.clear();
    keychainNotificationSent = false;
}

async function readDataDirToken(dataDir: string): Promise<string | null> {
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

export async function resolveGithubCopilotGhoToken(
    options: ResolveGithubCopilotGhoTokenOptions
): Promise<ResolvedGithubCopilotGhoToken | null> {
    if (resolvedTokenCache.has(options.dataDir)) {
        return resolvedTokenCache.get(options.dataDir) ?? null;
    }

    const dataDirToken = await readDataDirToken(options.dataDir);
    if (dataDirToken) {
        return cacheResolved(options.dataDir, { token: dataDirToken, source: "data-dir" });
    }

    for (const entry of readEnvTokens()) {
        return cacheResolved(options.dataDir, { token: entry.token, source: entry.source });
    }

    const cliConfig = readCopilotCliConfig();
    const loginHint = cliConfig?.lastLoggedInUser?.login;
    const hostHint = cliConfig?.lastLoggedInUser?.host ?? "https://github.com";

    if (loginHint) {
        const plaintext = readCopilotCliPlaintextToken(loginHint);
        if (plaintext) {
            return cacheResolved(options.dataDir, {
                token: plaintext,
                source: "copilot-cli-plaintext",
                loginHint,
            });
        }
    }

    if (!options.allowKeychain || !loginHint) {
        return cacheResolved(options.dataDir, null);
    }

    if (options.notifyBeforeKeychain !== false) {
        await notifyBeforeKeychainAccess(loginHint);
    }

    const keychainAccount = copilotCliKeychainAccount(hostHint, loginHint);
    const keychainToken = await readCopilotCliKeychainToken(keychainAccount);

    if (!keychainToken) {
        return cacheResolved(options.dataDir, null);
    }

    return cacheResolved(options.dataDir, {
        token: keychainToken,
        source: "copilot-cli-keychain",
        loginHint,
    });
}
