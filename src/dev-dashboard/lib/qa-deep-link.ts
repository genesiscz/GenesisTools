import { getConfig } from "@app/dev-dashboard/config";

export async function buildQaDeepLink(entryId: string): Promise<string> {
    const config = await getConfig();
    const host = config.allowedHosts[0] ?? "localhost";
    const needsPort = host === "localhost" || host === "127.0.0.1";

    return `http://${host}${needsPort ? `:${config.port}` : ""}/qa?id=${encodeURIComponent(entryId)}`;
}
