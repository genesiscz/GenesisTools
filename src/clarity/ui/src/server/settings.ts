import { ClarityApi } from "../../../../utils/clarity";
import { parseCurl } from "../../../../utils/curl";
import { getConfig, saveConfig } from "../../../config";

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
        });

        // Try to fetch a known timesheet or discover via carousel
        const firstMapping = config.mappings[0];

        if (firstMapping?.clarityTimesheetId) {
            await api.getTimesheet(firstMapping.clarityTimesheetId);
            return { success: true, message: "Connected successfully" };
        }

        return { success: true, message: "Config present but no timesheet to test against" };
    } catch (err) {
        return {
            success: false,
            message: err instanceof Error ? err.message : String(err),
        };
    }
}

export async function updateAuth(curl: string): Promise<{ success: boolean; message: string }> {
    const config = await getConfig();

    if (!config) {
        return { success: false, message: "Not configured. Run: tools clarity configure" };
    }

    try {
        const parsed = parseCurl(curl);

        const authToken =
            (parsed.headers.authtoken as string) ??
            (parsed.headers.authToken as string) ??
            (parsed.headers.AuthToken as string);

        if (!authToken) {
            return { success: false, message: "No authToken header found in cURL" };
        }

        // Extract sessionId from cookies
        const cookieHeader = (parsed.headers.cookie as string) ?? (parsed.headers.Cookie as string) ?? "";
        const sessionMatch = cookieHeader.match(/sessionId=([^;]+)/);
        const sessionId = sessionMatch?.[1] ?? "";

        if (!sessionId) {
            return { success: false, message: "No sessionId cookie found in cURL" };
        }

        config.authToken = authToken;
        config.sessionId = sessionId;
        await saveConfig(config);

        return { success: true, message: "Auth tokens updated" };
    } catch (err) {
        return {
            success: false,
            message: err instanceof Error ? err.message : String(err),
        };
    }
}
