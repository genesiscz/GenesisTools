import { loadConfig as loadAdoConfig } from "@app/azure-devops/config";
import { getConfig, saveConfig } from "@app/clarity/config";
import { parseAuthCurl } from "@app/clarity/lib/parse-auth-curl";
import { ClarityApi } from "@app/utils/clarity";

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
    const config = await getConfig();

    if (!config) {
        return { success: false, message: "Not configured. Run: tools clarity configure" };
    }

    try {
        const { authToken, sessionId, cookies } = parseAuthCurl(curl);

        config.authToken = authToken;
        config.sessionId = sessionId;
        config.cookies = cookies;
        await saveConfig(config);

        return { success: true, message: "Auth tokens updated" };
    } catch (err) {
        return {
            success: false,
            message: err instanceof Error ? err.message : String(err),
        };
    }
}
