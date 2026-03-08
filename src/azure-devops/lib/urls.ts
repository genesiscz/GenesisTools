/**
 * Build a URL to an Azure DevOps work item.
 * Pure function — pass org/project config explicitly.
 * For CLI convenience, use `resolveWorkItemUrl()` from `../config.js` which auto-loads config.
 */
export function buildWorkItemUrl(id: number, adoConfig?: { org: string; project: string } | null): string | null {
    if (!adoConfig?.org || !adoConfig?.project) {
        return null;
    }

    return `${adoConfig.org}/${encodeURIComponent(adoConfig.project)}/_workitems/edit/${id}`;
}
