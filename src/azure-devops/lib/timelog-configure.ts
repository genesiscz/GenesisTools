import { AZURE_DEVOPS_RESOURCE_ID } from "@app/azure-devops/api";
import { SafeJSON } from "@app/utils/json";
import { buildUrl } from "@app/utils/url";
import { $ } from "bun";

/**
 * Fetch the TimeLog API key from Azure DevOps Extension Data API.
 *
 * TimeLog (publisher: "TimeLog", extension: "time-logging") is a third-party
 * ADO extension that stores its API key in Extension Data under the "$settings"
 * collection. We query the ExtensionManagement API to read it.
 *
 * Requires: Azure CLI logged in (`az login`) with access to the org.
 */
export async function fetchTimeLogFunctionsKey(orgName: string): Promise<string> {
    const uri = buildUrl({
        base: "https://extmgmt.dev.azure.com",
        segments: [
            orgName,
            "_apis",
            "ExtensionManagement",
            "InstalledExtensions",
            "TimeLog",
            "time-logging",
            "Data",
            "Scopes",
            "Default",
            "Current",
            "Collections",
            "%24settings",
            "Documents",
        ],
        queryParams: { "api-version": "7.1-preview" },
    });

    const result =
        await $`az rest --method GET --resource "${AZURE_DEVOPS_RESOURCE_ID}" --uri "${uri}"`.quiet();

    const data = SafeJSON.parse(result.text(), { strict: true });
    const configDoc = data.find((d: { id: string }) => d.id === "Config");

    if (!configDoc?.value) {
        throw new Error("TimeLog extension not configured in Azure DevOps");
    }

    const settings = SafeJSON.parse(configDoc.value, { strict: true });
    const apiKey = settings.find((s: { id: string }) => s.id === "ApiKeyTextBox")?.value;

    if (!apiKey) {
        throw new Error("API key not found in TimeLog settings");
    }

    return apiKey;
}
