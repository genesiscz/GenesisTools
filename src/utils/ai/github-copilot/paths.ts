import { homedir } from "node:os";
import { join } from "node:path";
import { env } from "@app/utils/env";
import type { AuthStorageKey } from "@app/utils/storage";

export const COPILOT_DEFAULT_DATA_DIR = join(homedir(), ".local", "share", "copilot-api");
export const COPILOT_INDIVIDUAL_API = "https://api.githubcopilot.com";
export const COPILOT_TOKEN_URL = "https://api.github.com/copilot_internal/v2/token";
export const COPILOT_USER_URL = "https://api.github.com/copilot_internal/user";

/** Namespace for ai-proxy's own gho_ token entries in AuthStorage / Keychain. */
export const COPILOT_GHO_TOKEN_SERVICE = "ai-proxy.github-copilot";

export function copilotDataDir(override?: string): string {
    return override ?? env.copilot.getApiHome() ?? COPILOT_DEFAULT_DATA_DIR;
}

export function githubTokenPath(dataDir: string): string {
    return join(dataDir, "github_token");
}

export function copilotSessionCachePath(dataDir: string): string {
    return join(dataDir, "session.json");
}

export function copilotGhoTokenAuthKey(dataDir: string): AuthStorageKey {
    return { service: COPILOT_GHO_TOKEN_SERVICE, account: dataDir };
}
