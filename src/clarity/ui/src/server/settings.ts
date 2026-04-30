import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Api } from "@app/azure-devops/api";
import { extractOrgName, findConfigPath, loadConfig as loadAdoConfig } from "@app/azure-devops/config";
import { buildAdoConfig, checkAzureCliLogin, saveAdoConfig } from "@app/azure-devops/lib/ado-configure";
import { fetchTimeLogFunctionsKey } from "@app/azure-devops/lib/timelog-configure";
import type { AzureConfigWithTimeLog } from "@app/azure-devops/types";
import { getConfig, saveConfig } from "@app/clarity/config";
import { parseAuthCurl } from "@app/clarity/lib/parse-auth-curl";
import { type AuthStatus, pingAdo, pingClarity, pingTimelog, type ServiceAuthState } from "@app/clarity/lib/preflight";
import { ClarityApi } from "@app/utils/clarity";
import { SafeJSON } from "@app/utils/json";

export type { AuthStatus, ServiceAuthState };

export interface StatusResult {
    configured: boolean;
    baseUrl: string | null;
    hasAuth: boolean;
    mappingsCount: number;
    resourceId: number | null;
    uniqueName: string | null;
}

export async function getStatus(): Promise<StatusResult> {
    const config = await getConfig();

    if (!config) {
        return {
            configured: false,
            baseUrl: null,
            hasAuth: false,
            mappingsCount: 0,
            resourceId: null,
            uniqueName: null,
        };
    }

    return {
        configured: true,
        baseUrl: config.baseUrl,
        hasAuth: !!config.authToken && !!config.sessionId,
        mappingsCount: config.mappings.length,
        resourceId: config.resourceId ?? null,
        uniqueName: config.uniqueName ?? null,
    };
}

export async function testConnection(): Promise<{ success: boolean; message: string }> {
    const config = await getConfig();

    if (!config) {
        return { success: false, message: "Not configured" };
    }

    try {
        const api = new ClarityApi({
            baseUrl: config.baseUrl,
            authToken: config.authToken,
            sessionId: config.sessionId,
            cookies: config.cookies,
        });

        await api.getTimesheetApp();
        return { success: true, message: "Connected successfully" };
    } catch (err) {
        return {
            success: false,
            message: err instanceof Error ? err.message : String(err),
        };
    }
}

export async function getAdoConfig(): Promise<{ configured: boolean; org: string | null; project: string | null }> {
    const config = loadAdoConfig();

    if (!config) {
        return { configured: false, org: null, project: null };
    }

    return { configured: true, org: config.org, project: config.project };
}

export async function searchAdoWorkItems(
    query: string
): Promise<{ items: Array<{ id: number; title: string; type: string; state: string }> }> {
    const config = loadAdoConfig();

    if (!config) {
        throw new Error("Azure DevOps not configured");
    }

    const { searchWorkItems } = await import("@app/azure-devops/lib/work-item-search");
    const items = await searchWorkItems(config, query);

    return { items };
}

export async function updateAuth(curl: string): Promise<{ success: boolean; message: string }> {
    try {
        const { baseUrl, authToken, sessionId, cookies } = parseAuthCurl(curl);

        const existing = await getConfig();

        if (existing) {
            existing.authToken = authToken;
            existing.sessionId = sessionId;
            existing.cookies = cookies;
            if (baseUrl) {
                existing.baseUrl = baseUrl;
            }

            await saveConfig(existing);
            return { success: true, message: "Auth tokens updated" };
        }

        // First-time setup: create config from cURL, then fetch resource info
        const api = new ClarityApi({ baseUrl, authToken, sessionId, cookies });
        const appData = await api.getTimesheetApp(0);
        const resource = appData.resource._results[0];

        await saveConfig({
            baseUrl,
            authToken,
            sessionId,
            cookies,
            resourceId: resource?.id,
            uniqueName: resource?.email,
            mappings: [],
        });

        const name = resource ? ` as ${resource.full_name}` : "";
        return { success: true, message: `Clarity configured${name}` };
    } catch (err) {
        return {
            success: false,
            message: err instanceof Error ? err.message : String(err),
        };
    }
}

// ============= Granular Configuration Status =============

interface ClarityShape {
    configured: boolean;
    baseUrl: string | null;
    hasAuth: boolean;
    mappingsCount: number;
    resourceId: number | null;
    uniqueName: string | null;
}

interface AdoShape {
    configured: boolean;
    org: string | null;
    project: string | null;
    projectId: string | null;
    hasOrgId: boolean;
}

interface TimelogShape {
    configured: boolean;
    hasFunctionsKey: boolean;
    defaultUser: { userId: string; userName: string; userEmail: string } | null;
}

export interface GranularStatus {
    clarity: ClarityShape & ServiceAuthState;
    ado: AdoShape & ServiceAuthState;
    timelog: TimelogShape & ServiceAuthState;
    projectCwd: string;
}

function buildClarityShape(config: Awaited<ReturnType<typeof getConfig>>): ClarityShape {
    if (!config) {
        return {
            configured: false,
            baseUrl: null,
            hasAuth: false,
            mappingsCount: 0,
            resourceId: null,
            uniqueName: null,
        };
    }

    return {
        configured: true,
        baseUrl: config.baseUrl,
        hasAuth: !!config.authToken && !!config.sessionId,
        mappingsCount: config.mappings.length,
        resourceId: config.resourceId ?? null,
        uniqueName: config.uniqueName ?? null,
    };
}

function buildAdoShape(config: AzureConfigWithTimeLog | null): AdoShape {
    if (!config) {
        return { configured: false, org: null, project: null, projectId: null, hasOrgId: false };
    }

    return {
        configured: true,
        org: config.org,
        project: config.project,
        projectId: config.projectId,
        hasOrgId: !!config.orgId,
    };
}

function buildTimelogShape(config: AzureConfigWithTimeLog | null): TimelogShape {
    return {
        configured: !!config?.timelog?.functionsKey,
        hasFunctionsKey: !!config?.timelog?.functionsKey,
        defaultUser: config?.timelog?.defaultUser ?? null,
    };
}

export async function getGranularStatus(): Promise<GranularStatus> {
    const clarityConfig = await getConfig();
    const adoConfig = loadAdoConfig() as AzureConfigWithTimeLog | null;
    const projectCwd = process.env.CLARITY_PROJECT_CWD || process.cwd();

    const [clarityAuth, adoAuth, timelogAuth] = await Promise.all([
        pingClarity(clarityConfig),
        pingAdo(adoConfig),
        pingTimelog(adoConfig),
    ]);

    return {
        clarity: { ...buildClarityShape(clarityConfig), ...clarityAuth },
        ado: { ...buildAdoShape(adoConfig), ...adoAuth },
        timelog: { ...buildTimelogShape(adoConfig), ...timelogAuth },
        projectCwd,
    };
}

// ============= ADO Configuration =============

export async function configureAdo(
    url: string
): Promise<{ success: boolean; message: string; config?: { org: string; project: string; projectId: string } }> {
    try {
        await checkAzureCliLogin();
        const config = await buildAdoConfig(url);
        const configDir = join(process.env.CLARITY_PROJECT_CWD || process.cwd(), ".claude/azure");
        saveAdoConfig(config, configDir);

        return {
            success: true,
            message: `Configured Azure DevOps: ${config.org}/${config.project}`,
            config: { org: config.org, project: config.project, projectId: config.projectId },
        };
    } catch (err) {
        return {
            success: false,
            message: err instanceof Error ? err.message : String(err),
        };
    }
}

// ============= TimeLog Configuration =============

export async function configureTimeLogKey(): Promise<{ success: boolean; message: string }> {
    try {
        const adoConfig = loadAdoConfig();

        if (!adoConfig) {
            return { success: false, message: "Azure DevOps not configured. Configure ADO first." };
        }

        const orgName = extractOrgName(adoConfig.org);

        if (!orgName) {
            return { success: false, message: `Could not extract org name from: ${adoConfig.org}` };
        }

        const functionsKey = await fetchTimeLogFunctionsKey(orgName);

        const configPath = findConfigPath();

        if (!configPath) {
            return { success: false, message: "Could not find ADO config file" };
        }

        const raw = readFileSync(configPath, "utf-8");
        const parsed = SafeJSON.parse(raw) as AzureConfigWithTimeLog;

        if (!parsed.timelog) {
            parsed.timelog = { functionsKey };
        } else {
            parsed.timelog.functionsKey = functionsKey;
        }

        writeFileSync(configPath, SafeJSON.stringify(parsed, null, 2));

        return { success: true, message: "TimeLog API key configured" };
    } catch (err) {
        return {
            success: false,
            message: err instanceof Error ? err.message : String(err),
        };
    }
}

// ============= Team Members =============

export async function fetchTeamMembers(): Promise<{
    members: Array<{ id: string; displayName: string; uniqueName: string; imageUrl?: string }>;
}> {
    const adoConfig = loadAdoConfig();

    if (!adoConfig) {
        throw new Error("Azure DevOps not configured");
    }

    const api = new Api(adoConfig);
    const raw = await api.getTeamMembers();

    const members = raw
        .filter((m) => !!m.id)
        .map((m) => ({
            id: m.id as string,
            displayName: m.displayName,
            uniqueName: m.uniqueName ?? m.displayName,
            ...(m.imageUrl ? { imageUrl: m.imageUrl } : {}),
        }));

    return { members };
}

// ============= TimeLog Default User =============

export async function setTimeLogDefaultUser(user: {
    userId: string;
    userName: string;
    userEmail: string;
}): Promise<{ success: boolean; message: string }> {
    try {
        const configPath = findConfigPath();

        if (!configPath) {
            return { success: false, message: "Could not find ADO config file" };
        }

        const raw = readFileSync(configPath, "utf-8");
        const parsed = SafeJSON.parse(raw) as AzureConfigWithTimeLog;

        if (!parsed.timelog) {
            parsed.timelog = { functionsKey: "", defaultUser: user };
        } else {
            parsed.timelog.defaultUser = user;
        }

        writeFileSync(configPath, SafeJSON.stringify(parsed, null, 2));

        return { success: true, message: `Default user set to ${user.userName}` };
    } catch (err) {
        return {
            success: false,
            message: err instanceof Error ? err.message : String(err),
        };
    }
}
