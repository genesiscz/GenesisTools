import { loadConfig } from "@app/azure-devops/config";
import { TimeLogApi } from "@app/azure-devops/timelog-api";
import type { AzureConfigWithTimeLog, TimeLogUser } from "@app/azure-devops/types";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";

/** The setup step that is missing, so a dashboard can point at its own form instead of a command. */
export type TimeLogSetupStep = "azure-devops" | "org-id" | "project-id" | "timelog-key" | "timelog-user";

export class TimeLogSetupError extends Error {
    constructor(
        readonly step: TimeLogSetupStep,
        message: string
    ) {
        super(message);
        this.name = "TimeLogSetupError";
    }
}

/** The TimeLog API for the saved Azure DevOps config and its TimeLog user. Throws TimeLogSetupError naming the missing step. */
export function getTimeLogApi(options: { config?: AzureConfigWithTimeLog; user?: TimeLogUser } = {}): TimeLogApi {
    const config = options.config ?? (loadConfig() as AzureConfigWithTimeLog | null);
    const configure = `${toolCommand("azure-devops configure")} "<any Azure DevOps URL of your project>"`;

    if (!config) {
        throw new TimeLogSetupError("azure-devops", `No Azure DevOps configuration found. Run: ${configure}`);
    }

    if (!config.orgId) {
        throw new TimeLogSetupError(
            "org-id",
            `Organization ID missing from the Azure DevOps config. Run: ${configure}`
        );
    }

    if (!config.projectId) {
        throw new TimeLogSetupError("project-id", `Project ID missing from the Azure DevOps config. Run: ${configure}`);
    }

    if (!config.timelog?.functionsKey) {
        throw new TimeLogSetupError(
            "timelog-key",
            `TimeLog is not configured. Run: ${toolCommand("azure-devops timelog configure")}`
        );
    }

    const user = options.user ?? config.timelog.defaultUser;

    if (!user) {
        throw new TimeLogSetupError(
            "timelog-user",
            `TimeLog user is not configured. Run: ${toolCommand("azure-devops timelog configure")}`
        );
    }

    return new TimeLogApi(config.orgId, config.projectId, config.timelog.functionsKey, user);
}
