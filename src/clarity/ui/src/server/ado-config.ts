import { loadConfig as loadAdoConfig } from "@app/azure-devops/config";
import { getTimeLogApi, TimeLogSetupError, type TimeLogSetupStep } from "@app/azure-devops/lib/timelog-client";
import type { TimeLogApi } from "@app/azure-devops/timelog-api";
import type { AzureConfigWithTimeLog, TimeLogUser } from "@app/azure-devops/types";

const SettingsSteps: Record<TimeLogSetupStep, string> = {
    "azure-devops": "Azure DevOps is not configured. Open Settings and complete the Azure DevOps section.",
    "org-id": "Organization ID missing from config. Open Settings and reconnect Azure DevOps.",
    "project-id": "Project ID missing from config. Open Settings and reconnect Azure DevOps.",
    "timelog-key": "TimeLog API key is missing. Open Settings and complete the TimeLog section.",
    "timelog-user": "TimeLog user is missing. Open Settings and choose a TimeLog team member.",
};

/**
 * The Azure DevOps preconditions, as a THROW rather than an exit, worded for the Settings page.
 *
 * `requireTimeLogConfig` / `requireTimeLogUser` / `requireConfig` in `src/azure-devops` all call
 * `process.exit(1)` on a missing field. That is right for a CLI and fatal for the dev server: a
 * half-configured account — the normal state between the Settings steps the error text points at —
 * would take the whole server down mid-request and the fetch would never return.
 */
export function requireAdoTimeLogConfig(): { config: AzureConfigWithTimeLog; user: TimeLogUser; api: TimeLogApi } {
    const config = loadAdoConfig() as AzureConfigWithTimeLog | null;

    try {
        const api = getTimeLogApi({ config: config ?? undefined });

        return { config: config!, user: api.user, api };
    } catch (err) {
        if (err instanceof TimeLogSetupError) {
            throw new Error(SettingsSteps[err.step]);
        }

        throw err;
    }
}
