/** Port of chrome-har lib/finalizeEntry.js (v1.3.1, MIT). Behavior kept 1:1. */
import type { HarEntry } from "./types.ts";
import { formatMillis, isHttp1x } from "./util.ts";

export function finalizeEntry(entry: HarEntry, params: { timestamp: number; encodedDataLength?: number }): void {
    const timings = entry.timings ?? ({} as NonNullable<HarEntry["timings"]>);
    timings.receive = formatMillis(
        (params.timestamp - (entry._requestTime ?? 0)) * 1000 - (entry.__receiveHeadersEnd ?? 0)
    );
    entry.time =
        Math.max(0, timings.blocked) +
        Math.max(0, timings.dns) +
        Math.max(0, timings.connect) +
        Math.max(0, timings.send) +
        Math.max(0, timings.wait) +
        Math.max(0, timings.receive);

    // encodedDataLength will be -1 sometimes
    if (params.encodedDataLength !== undefined && params.encodedDataLength >= 0) {
        const response = entry.response;
        if (response) {
            response._transferSize = params.encodedDataLength;
            response.bodySize = params.encodedDataLength;

            if (isHttp1x(response.httpVersion) && response.headersSize > -1) {
                response.bodySize -= response.headersSize;
            }

            const compression = Math.max(0, response.content.size - response.bodySize);
            if (compression > 0) {
                response.content.compression = compression;
            }
        }
    }
}
