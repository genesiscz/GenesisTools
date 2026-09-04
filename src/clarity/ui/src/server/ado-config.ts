import { loadConfig as loadAdoConfig } from "@app/azure-devops/config";
import { TimeLogApi } from "@app/azure-devops/timelog-api";
import type { AzureConfigWithTimeLog, TimeLogUser } from "@app/azure-devops/types";

/**
 * The Azure DevOps preconditions, as a THROW rather than an exit.
 *
 * `requireTimeLogConfig` / `requireTimeLogUser` / `requireConfig` in `src/azure-devops` all call
 * `process.exit(1)` on a missing field. That is right for a CLI and fatal for the dev server: a
 * half-configured account — the normal state between the Settings steps the error text points at —
 * would take the whole server down mid-request and the fetch would never return.
 */
export function requireAdoTimeLogConfig(): { config: AzureConfigWithTimeLog; user: TimeLogUser; api: TimeLogApi } {
    const config = loadAdoConfig() as AzureConfigWithTimeLog | null;

    if (!config) {
        throw new Error("Azure DevOps is not configured. Open Settings and complete the Azure DevOps section.");
    }

    if (!config.orgId) {
        throw new Error("Organization ID missing from config. Open Settings and reconnect Azure DevOps.");
    }

    if (!config.projectId) {
        throw new Error("Project ID missing from config. Open Settings and reconnect Azure DevOps.");
    }

    if (!config.timelog?.functionsKey) {
        throw new Error("TimeLog API key is missing. Open Settings and complete the TimeLog section.");
    }

    const user = config.timelog.defaultUser;

    if (!user) {
        throw new Error("TimeLog user is missing. Open Settings and choose a TimeLog team member.");
    }

    const api = new TimeLogApi(config.orgId, config.projectId, config.timelog.functionsKey, user);

    return { config, user, api };
}
