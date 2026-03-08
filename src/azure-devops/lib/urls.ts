import { loadConfig } from "../config.js";

/**
 * Build a URL to an Azure DevOps work item.
 * If adoConfig not provided, reads from ADO config file.
 */
export function buildWorkItemUrl(id: number, adoConfig?: { org: string; project: string } | null): string | null {
    const config = adoConfig ?? loadConfig();

    if (!config?.org || !config?.project) {
        return null;
    }

    return `${config.org}/${encodeURIComponent(config.project)}/_workitems/edit/${id}`;
}
