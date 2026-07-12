import { getConfig } from "@app/dev-dashboard/config";

/** User-facing base URL of this dashboard: the first configured allowed host (public
 *  hostname behind the tunnel, served over https) — or the local listener when no
 *  public host is configured. Deep links handed to humans must be built from THIS,
 *  never from the loopback API base a client happened to call in on. */
export async function publicBaseUrl(): Promise<string> {
    const config = await getConfig();
    const host = config.allowedHosts[0];
    if (host && host !== "localhost" && host !== "127.0.0.1") {
        return `https://${host}`;
    }

    return `http://localhost:${config.port}`;
}

export async function boardPageUrl(slug: string): Promise<string> {
    return `${await publicBaseUrl()}/boards/${slug}`;
}
