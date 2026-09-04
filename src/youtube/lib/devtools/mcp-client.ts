/**
 * The youtube-flavored door to the chrome-devtools MCP client
 * (`@app/chrome-devtools/lib/mcp`): same connect/close mechanics, with this
 * tool's own default CDP endpoint — the extension-loaded browser launched by
 * browser.ts, `YOUTUBE_EXTENSION_CDP_URL`, or port 9333.
 */

import { withMcp } from "@app/chrome-devtools/lib/mcp";
import { env } from "@genesiscz/utils/env.client";
import type { Client } from "@modelcontextprotocol/client";

const CLIENT_NAME = "genesis-yt-devtools-client";

export interface DevtoolsClientOpts {
    /** CDP endpoint of an already-running, extension-loaded browser (see browser.ts). */
    cdpUrl?: string;
}

/** The ONE place this tool's endpoint default lives; extension.ts derives its port from the same chain. */
export function devtoolsCdpUrl(cdpUrl?: string): string {
    return cdpUrl ?? env.extension.getCdpUrl() ?? "http://127.0.0.1:9333";
}

/** Connects, runs `fn`, and always closes the client afterward — even on throw. */
export async function withDevtoolsClient<T>(
    fn: (client: Client) => Promise<T>,
    opts: DevtoolsClientOpts = {}
): Promise<T> {
    return withMcp(fn, { cdpUrl: devtoolsCdpUrl(opts.cdpUrl), clientName: CLIENT_NAME });
}
