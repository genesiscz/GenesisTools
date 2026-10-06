import { fetchPinnedPublicUrl, type PinnedRequest } from "@genesiscz/utils/net/pinned-fetch";
import type { UrlMetadata } from "./metadata";
import { extractHtmlMetadata } from "./metadata";

const MAX_REDIRECTS = 5;
const MAX_HTML_BYTES = 64 * 1024;

async function readBoundedHtml(response: Response): Promise<string> {
    const reader = response.body?.getReader();
    if (!reader) {
        throw new Error("Response body is null");
    }

    const decoder = new TextDecoder();
    let html = "";
    let bytesRead = 0;

    try {
        while (bytesRead < MAX_HTML_BYTES) {
            const { done, value } = await reader.read();
            if (done) {
                break;
            }

            const remaining = MAX_HTML_BYTES - bytesRead;
            const accepted = value.byteLength > remaining ? value.subarray(0, remaining) : value;
            html += decoder.decode(accepted, { stream: accepted.byteLength === value.byteLength });
            bytesRead += accepted.byteLength;
        }
    } finally {
        await reader.cancel();
    }

    return html;
}

export async function fetchPublicUrlMetadata({
    target,
    signal,
    request,
}: {
    target: string;
    signal?: AbortSignal;
    request?: PinnedRequest;
}): Promise<UrlMetadata> {
    let currentUrl = new URL(target).href;

    for (let hop = 0; ; hop++) {
        const response = await fetchPinnedPublicUrl({
            target: currentUrl,
            signal,
            request,
            headers: {
                "User-Agent": "GenesisTools-Dashboard/1.0 (bookmark-metadata-fetcher)",
                Accept: "text/html,application/xhtml+xml",
            },
        });

        if (response.status >= 300 && response.status < 400) {
            const location = response.headers.get("location");
            if (!location) {
                throw new Error(`Redirect response from ${currentUrl} has no Location header`);
            }

            if (hop >= MAX_REDIRECTS) {
                throw new Error(`Too many redirects fetching ${target}`);
            }

            currentUrl = new URL(location, currentUrl).href;
            continue;
        }

        if (!response.ok) {
            throw new Error(`HTTP ${response.status} fetching ${target}`);
        }

        return extractHtmlMetadata(await readBoundedHtml(response), currentUrl);
    }
}
