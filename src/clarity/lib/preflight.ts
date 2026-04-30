/**
 * Shared liveness checks for ADO / Clarity / TimeLog.
 *
 * Used by both the `tools clarity ui` CLI bootstrap (to fail fast before Vite
 * starts) and the `/api/granular-status` server function (to drive the
 * System status / Settings UI dots and inline errors). Single source of truth
 * so both surfaces report the same state.
 */

import { Api } from "@app/azure-devops/api";
import { AzAuthError, isAuthError } from "@app/azure-devops/cli.utils";
import { loadConfig as loadAdoConfig } from "@app/azure-devops/config";
import { TimeLogApi } from "@app/azure-devops/timelog-api";
import type { AzureConfigWithTimeLog, TimeLogUser } from "@app/azure-devops/types";
import { type ClarityConfig, getConfig as getClarityConfig } from "@app/clarity/config";
import { ClarityApi } from "@app/utils/clarity";

export type AuthStatus = "ok" | "expired" | "error" | "unknown";

export interface ServiceAuthState {
    status: AuthStatus;
    error?: string;
    fix?: string;
}

const AZ_LOGIN_FALLBACK = "az login --allow-no-subscriptions --use-device-code";

export async function pingAdo(config: AzureConfigWithTimeLog | null): Promise<ServiceAuthState> {
    if (!config) {
        return { status: "unknown" };
    }

    try {
        const api = new Api(config);
        // getWorkItemTypeDefinitions is a single GET that exercises auth and is already
        // used by the work-item enrichment service — cheap and known-stable.
        await api.getWorkItemTypeDefinitions();
        return { status: "ok" };
    } catch (err) {
        if (err instanceof AzAuthError) {
            return {
                status: "expired",
                error: err.message,
                fix: err.suggestedCommand ?? AZ_LOGIN_FALLBACK,
            };
        }
        const msg = err instanceof Error ? err.message : String(err);
        if (isAuthError(msg)) {
            return { status: "expired", error: msg, fix: AZ_LOGIN_FALLBACK };
        }

        return { status: "error", error: msg };
    }
}

export async function pingClarity(config: ClarityConfig | null): Promise<ServiceAuthState> {
    if (!config) {
        return { status: "unknown" };
    }

    try {
        const api = new ClarityApi({
            baseUrl: config.baseUrl,
            authToken: config.authToken,
            sessionId: config.sessionId,
            cookies: config.cookies,
        });
        await api.getTimesheetApp();
        return { status: "ok" };
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const lower = msg.toLowerCase();
        const looksAuth =
            msg.includes("401") || msg.includes("403") || lower.includes("session") || lower.includes("token");
        return {
            status: looksAuth ? "expired" : "error",
            error: msg,
            fix: looksAuth ? "Paste a fresh cURL in Settings → Clarity Configuration" : undefined,
        };
    }
}

export async function pingTimelog(config: AzureConfigWithTimeLog | null): Promise<ServiceAuthState> {
    const functionsKey = config?.timelog?.functionsKey;
    if (!config || !functionsKey) {
        return { status: "unknown" };
    }

    // TimeLogApi requires a user, but listing time types doesn't actually consult it.
    // Use a synthetic placeholder so we can ping without depending on defaultUser being set.
    const user: TimeLogUser =
        config.timelog?.defaultUser ??
        ({ userId: "preflight", userName: "preflight", userEmail: "preflight@local" } as TimeLogUser);

    try {
        const api = new TimeLogApi(config.orgId ?? "", config.projectId, functionsKey, user);
        await api.getAllTimeTypes();
        return { status: "ok" };
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const looksAuth = msg.includes("401") || msg.includes("403");
        return {
            status: looksAuth ? "expired" : "error",
            error: msg,
            fix: looksAuth ? "tools azure-devops timelog configure  # rotates the functions key" : undefined,
        };
    }
}

export interface PreflightFailure {
    service: "ADO" | "Clarity" | "TimeLog";
    error: string;
    fix?: string;
}

/**
 * Run all three pings in parallel. Returns failures only — `unknown` (config
 * missing) is intentionally NOT a failure: it's a "go configure me" state and
 * the UI handles that path with its own copy.
 */
export async function runClarityPreflight(): Promise<{ failures: PreflightFailure[] }> {
    const adoConfig = loadAdoConfig() as AzureConfigWithTimeLog | null;
    const clarityConfig = await getClarityConfig();

    const [ado, clarity, timelog] = await Promise.all([
        pingAdo(adoConfig),
        pingClarity(clarityConfig),
        pingTimelog(adoConfig),
    ]);

    const failures: PreflightFailure[] = [];
    if ((ado.status === "expired" || ado.status === "error") && ado.error) {
        failures.push({ service: "ADO", error: ado.error, fix: ado.fix });
    }

    if ((clarity.status === "expired" || clarity.status === "error") && clarity.error) {
        failures.push({ service: "Clarity", error: clarity.error, fix: clarity.fix });
    }

    if ((timelog.status === "expired" || timelog.status === "error") && timelog.error) {
        failures.push({ service: "TimeLog", error: timelog.error, fix: timelog.fix });
    }

    return { failures };
}
