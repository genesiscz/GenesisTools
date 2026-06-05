import { getConfig } from "@app/dev-dashboard/config";

export async function buildQaDeepLink(entryId: string): Promise<string> {
    const config = await getConfig();
    const host = config.allowedHosts[0] ?? "localhost";

    return `http://${host}:${config.port}/qa?id=${encodeURIComponent(entryId)}`;
}
