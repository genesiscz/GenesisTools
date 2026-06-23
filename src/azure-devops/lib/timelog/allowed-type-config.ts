import type { AllowedTypeConfig, AzureConfigWithTimeLog } from "@app/azure-devops/types";

export function buildAllowedTypeConfig(config: AzureConfigWithTimeLog): AllowedTypeConfig | undefined {
    if (!config.timelog?.allowedWorkItemTypes?.length) {
        return undefined;
    }

    return {
        allowedWorkItemTypes: config.timelog.allowedWorkItemTypes,
        allowedStatesPerType: config.timelog.allowedStatesPerType,
        deprioritizedStates: config.timelog.deprioritizedStates,
        defaultUserName: config.timelog.defaultUser?.userName,
    };
}
