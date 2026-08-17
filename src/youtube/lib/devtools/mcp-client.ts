/**
 * The youtube-flavored door to the shared chrome-devtools-mcp client
 * (`@genesiscz/utils/devtools/mcp-client`): same connect/close mechanics,
 * with this tool's own default CDP endpoint — the extension-loaded browser
 * launched by browser.ts, `YOUTUBE_EXTENSION_CDP_URL`, or port 9333.
 */

import {
    connectDevtoolsClient as connectShared,
    withDevtoolsClient as withShared,
} from "@genesiscz/utils/devtools/mcp-client";
import { env } from "@genesiscz/utils/env.client";
import type { Client } from "@modelcontextprotocol/client";

export interface DevtoolsClientOpts {
    /** CDP endpoint of an already-running, extension-loaded browser (see browser.ts). */
    cdpUrl?: string;
}

export async function connectDevtoolsClient(opts: DevtoolsClientOpts = {}): Promise<Client> {
    const cdpUrl = opts.cdpUrl ?? env.extension.getCdpUrl() ?? "http://127.0.0.1:9333";

    return connectShared({ cdpUrl, clientName: "genesis-yt-devtools-client" });
}

/** Connects, runs `fn`, and always closes the client afterward — even on throw. */
export async function withDevtoolsClient<T>(
    fn: (client: Client) => Promise<T>,
    opts: DevtoolsClientOpts = {}
): Promise<T> {
    const cdpUrl = opts.cdpUrl ?? env.extension.getCdpUrl() ?? "http://127.0.0.1:9333";

    return withShared(fn, { cdpUrl, clientName: "genesis-yt-devtools-client" });
}
